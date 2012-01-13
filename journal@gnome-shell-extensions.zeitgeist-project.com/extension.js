
/* -*- mode: js2; js2-basic-offset: 4; indent-tabs-mode: nil -*- */
	
/* JournalDisplay object to show a timeline of the user's past activities
 *
 * This file exports a JournalDisplay object, which carries a JournalDisplay.actor.
 * This is a view of the user's past activities, shown as a timeline, and
 * whose data comes from what is logged in the Zeitgeist service.
 */

/* Style classes used here:
 *
 * journal - The main journal layout
 *     item-spacing - Horizontal space between items in the journal view
 *     row-spacing - Vertical space between rows in the journal view
 *
 * journal-heading - Heading labels for date blocks inside the journal
 *
 * .journal-item .overview-icon - Items in the journal, used to represent files/documents/etc.
 * You can style "icon-size", "font-size", etc. in them; the hierarchy for each item is
 * is StButton -> IconGrid.BaseIcon
 */

const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Gio = imports.gi.Gio;
const Gtk = imports.gi.Gtk;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;
const Gettext = imports.gettext.domain('gnome-shell');
const _ = Gettext.gettext;
const C_ = Gettext.pgettext;
const Tp = imports.gi.TelepathyGLib;

const Extension = imports.ui.extensionSystem.extensions["journal@gnome-shell-extensions.zeitgeist-project.com"];

const IconGrid = imports.ui.iconGrid;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Util = imports.misc.util;
const DocInfo = Extension.docInfo;
const Semantic = Extension.semantic;
const Zeitgeist = Extension.zeitgeist;
const ViewSelector = imports.ui.viewSelector;


//*** JournalLayout ***
//
// This is a dumb "flow" layout - it doesn't implement behavior on its own; rather,
// it just lays out items as specified by the caller, and leaves all the behavior
// of those items up to the caller itself.
//
// JournalLayout lets you build a layout like this:
//
//    Heading2
//
//    [item]  [item]  [item]
//    [longitem]  [item]  [item]
//
//    Heading2
//
//    [item]  [item]
//
// It does this with just three methods:
//
//   - appendItem (item) - Expects an item.actor - just inserts that actor into the layout.
//
//   - appendHSpace () - Adds a horizontal space after the last item.  The amount of
//     space comes from the "item-spacing" CSS attribute within the "journal" style class.
//
//   - appendNewline () - Adds a newline after the last item, and moves the layout cursor
//     to the leftmost column in the view.  The vertical space between rows comes from
//     the "row-spacing" CSS attribute within the "journal" style class.

function formatDate(date, fmt) {
    function pad(value) {
        return (value.toString().length < 2) ? '0' + value : value;
    }
    return fmt.replace(/%([a-zA-Z])/g, function (_, fmtCode) {
        switch (fmtCode) {
        case 'Y':
            return date.getUTCFullYear();
        case 'M':
            return pad(date.getUTCMonth() + 1);
        case 'd':
            return pad(date.getUTCDate());
        case 'H':
            return pad(date.getUTCHours());
        case 'm':
            return pad(date.getUTCMinutes());
        case 's':
            return pad(date.getUTCSeconds());
        default:
            throw new Error('Unsupported format code: ' + fmtCode);
        }
    });
}

//*** EventItem ***
//
// This is an item that wraps a ZeitgeistItemInfo, which is in turn
// created from an event as returned by the Zeitgeist D-Bus API.

function EventItem (event, multi_select, journal_layout) {
    this._init (event, multi_select, journal_layout);
}

EventItem.prototype = {
    _init: function (event, multi_select, journal_layout) {
        if (!event)
            throw new Error ("event must not be null");

        this._journal_layout = journal_layout;
        this._item_info = new DocInfo.ZeitgeistItemInfo (event);
        this._icon = new IconGrid.BaseIcon (this._item_info.name,
                                            { createIcon: Lang.bind (this, function (size) {
                                                  return this._item_info.createIcon (size);
                                              })
                                            });

        this.actor = new St.Group ({ reactive: true});
        this.actor.connect('enter-event', Lang.bind(this, this._onEnter));
        this.actor.connect('leave-event', Lang.bind(this, this._onLeave)); 

        this._button = new St.Button ({ style_class: "journal-item",
                                        reactive: true,
                                        can_focus: true,
                                        button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE, // assume button 2 (middle) does nothing
                                        x_fill: true,
                                        y_fill: true });
        this._button.set_child (this._icon.actor);
        this._button.connect ('clicked', Lang.bind(this, this._onButtonPress));

        this._closeButton = new St.Button ({ style_class: "window-close" });
        this._closeButton.connect ('clicked', Lang.bind(this, this._removeItem));
        this._closeButton.connect ('style-changed',
                                         Lang.bind(this, this._onStyleChanged));
    
        this.actor.add_actor (this._button);
        this.actor.add_actor (this._closeButton);

        this._closeButton.hide();

        this._idleToggleCloseId = 0;
        this._menuTimeoutId = 0;
        this._menuDown = 0;

        this._menu = null;
        this._menuManager = new PopupMenu.PopupMenuManager(this);

        this.multiSelect = multi_select;
    },

    _onDestroy: function() {
        //if (this._journalLayout != undefined)
        //    this._journalLayout.removeHSpace(this);
    },

    _removeMenuTimeout: function() {
        if (this._menuTimeoutId > 0) {
            Mainloop.source_remove(this._menuTimeoutId);
            this._menuTimeoutId = 0;
        }
    },

    // callback for this._button's "clicked" signal
    _onButtonPress: function (actor, button) {
        this._removeMenuTimeout();
        if (button == 1) {
            let modifiers = Shell.get_event_state(Clutter.get_current_event ());
            if (modifiers & Clutter.ModifierType.CONTROL_MASK) {
                this.multiSelect.select (this._button, this._item_info);
            } else {
                let elements = this.multiSelect.querySelections ();
                this._launchAll(elements);
            }
        } else if (button == 3) {
            this._popupMenu();
            this._idleToggleCloseButton ();
        }
        return true;
    },

    _launchAll: function(elements) {
        if (elements.length > 1) {
            for (let i = 0; i < elements.length; i++) {
                let e = elements[i];
                if (e.item.subject.interpretation == Semantic.NMO_IMMESSAGE)
                    Util.spawn(['empathy', e.item.subject.uri]);
                else
                    e.item.launch ();
            }
            this.multiSelect.destroy ();
        } else {
            if (this._item_info.subject.interpretation == Semantic.NMO_IMMESSAGE)
                Util.spawn(['empathy', this._item_info.subject.uri]);
            else
                this._item_info.launch ();
            Main.overview.hide ();
        }
    },

    _onEnter: function() {
        this._closeButton.show();
    },
    
    _onLeave: function() {
        if (this._idleToggleCloseId == 0)
            this._idleToggleCloseId = Mainloop.timeout_add(10, Lang.bind(this, this._idleToggleCloseButton));
    },

    _idleToggleCloseButton: function() {
        this._idleToggleCloseId = 0;
        if ((!this._button.has_pointer &&
              !this._closeButton.has_pointer) ||
              this._menu)
            this._closeButton.hide();

        return false;
    },

    // FIXME: Calculate (X) positions.
    _updatePosition: function () {
        let closeNode = this._closeButton.get_theme_node();
        this._closeButton._overlap = closeNode.get_length('-shell-close-overlap');

        let [buttonX, buttonY] = this._button.get_position();
        let [buttonWidth, buttonHeight] = this._button.get_size();
        
        buttonWidth = buttonWidth - 14 //this.actor.scale_x * (buttonWidth - 16);
        buttonHeight = buttonHeight - 12 //this.actor.scale_y * (buttonHeight - 16);
        
        //this._closeButton.y = buttonY - (this._closeButton.height - this._closeButton._overlap);
        this._closeButton.x = buttonX + (buttonWidth - this._closeButton._overlap);
    },

    _removeItem: function () {
        this.actor.connect('destroy', Lang.bind(this, this._onDestroy)); 
        _deleteEvents(this._item_info.name);
        this.multiSelect.unselect (this._button, this._item_info);
        this._journal_layout.removeItem(this);
        this._journal_layout.refresh();
        this.actor.destroy();
    },

    destroy: function (source, item) {
    },

    _onStyleChanged: function () {
        this._updatePosition ();
        this._closeButton.set_position (Math.floor(this._closeButton.x), Math.floor(this._closeButton.y));
    },

    _disconnectSignals: function() {
        this._menu.close();
        Main.overview.disconnect(this._overviewHidingId);
    },

    _popupMenu: function() {
        this._removeMenuTimeout();
        this._button.fake_release();
        if (!this._menu) {
            this._menu = new ActivityIconMenu(this);
            this._menu.connect('activate-window', Lang.bind(this, function (menu, window) {
                this.activateWindow(window);
            }));
            this._menu.connect('popup', Lang.bind(this, function (menu, isPoppedUp) {
                if (!isPoppedUp)
                    this._onMenuPoppedDown();
            }));
            
            this._overviewHidingId = Main.overview.connect('hiding', Lang.bind(this, function () { this._disconnectSignals();}));

            this._menuManager.addMenu(this._menu);
        }

        this._button.set_hover(true);
        this._button.show_tooltip();
        this._menu.popup();

        return false;
    },
    
    activateWindow: function(metaWindow) {
        if (metaWindow) {
            Main.activateWindow(metaWindow);
        } else {
            Main.overview.hide();
        }
    },

    _onMenuPoppedDown: function() {
        this._button.sync_hover();
    }

};




//*** ActivityIconMenu ***
//
// Build the actual PopupMenu and chain it back to the calling
// event source.

function ActivityIconMenu(source) {
    this._init(source);
}

ActivityIconMenu.prototype = {
    __proto__: PopupMenu.PopupMenu.prototype,

    _init: function(source) {
        let side = St.Side.LEFT;
        if (St.Widget.get_default_direction() == St.TextDirection.RTL)
            side = St.Side.RIGHT;

        PopupMenu.PopupMenu.prototype._init.call(this, source.actor, 0.5, side, 0);

        // We want to keep the item hovered while the menu is up
        this.blockSourceEvents = true;

        this._source = source;
        //this._favs = new FavoriteItem ();
        this._item = this._source._item_info;
       
        this._openWith = [];
        this._openWithItem = [];

        this.connect('activate', Lang.bind(this, this._onActivate));
        this.connect('open-state-changed', Lang.bind(this, this._onOpenStateChanged));

        this.actor.add_style_class_name('app-well-menu');

        // Chain our visibility and lifecycle to that of the source
        source.actor.connect('notify::mapped', Lang.bind(this, function () {
            if (!source.actor.mapped)
                this.close();
        }));
        source.actor.connect('destroy', Lang.bind(this, function () { this.actor.destroy(); }));

        Main.uiGroup.add_actor(this.actor);
    },

    _redisplay: function() {
        this.removeAll();
        let selections = this._source.multiSelect.querySelections ();
        
        if (selections.length < 2 || this._source.multiSelect.isSelected(this._item)) {
            if (this._item.subject.interpretation == Semantic.NMO_IMMESSAGE) {
                this._startConversation = this._appendMenuItem(_("Start a new conversation"));
                // dead menu entry, will probably be replaced by an option to launch gnome-contacts 
                // http://blogs.gnome.org/alexl/2011/06/13/announcing-gnome-contacts/
                this._previousConversations = this._appendMenuItem(_("Previous conversations"));
                this._appendSeparator();
            }
            else {
                let apps = Gio.app_info_get_recommended_for_type(this._item.subject.mimetype); 
                if (apps.length > 0) {      
                    for (let i = 0; i < apps.length; i++) {
                        this._openWith.push(this._appendMenuItem(_("Open with " + apps[i].get_name())));
                        this._openWithItem.push(apps[i]);
                    }
                    this._appendSeparator();
                }
            }
            //let isFavorite = this._favs.isFavorite(this._item.subject.uri);
            //this._toggleFavoriteMenuItem = this._appendMenuItem(isFavorite ? _("Remove from Favorites")
            //                                                         : _("Add to Favorites"));
            this._showItemInManager = this._appendMenuItem(_("Show in file manager"));
            this._moveFileToTrash = this._appendMenuItem(_("Move to trash"));
        } else {
            this._launchAllItems = this._appendMenuItem(_("Launch items"));
            this._appendSeparator();
            this._showItemsInManager = this._appendMenuItem(_("Show items file manager"));
            this._moveFilesToTrash = this._appendMenuItem(_("Move items to trash"));
        }
    },

    _appendSeparator: function () {
        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.addMenuItem(separator);
    },

    _appendMenuItem: function(labelText) {
        // FIXME: app-well-menu-item style
        let item = new PopupMenu.PopupMenuItem(labelText);
        this.addMenuItem(item);
        return item;
    },

    popup: function(activatingButton) {
        this._redisplay();
        this.open();
    },

    _onOpenStateChanged: function (menu, open) {
        if (open) {
            this.emit('popup', true);
        } else {
            this.emit('popup', false);
        }
    },

    _onActivate: function (actor, child) {
        let selections = this._source.multiSelect.querySelections ();
        let menuIndex = this._openWith.indexOf(child);
        if (child._window) {
            let metaWindow = child._window;
            this.emit('activate-window', metaWindow);
        } else if (menuIndex > -1) {
              this._openWithItem[menuIndex].launch_uris([this._item.subject.uri], null);
        } else if (child == this._launchAllItems) {
            this._source._launchAll(selections);
        /*} else if (child == this._toggleFavoriteMenuItem) {
            /*
            let isFavorite = this._favs.isFavorite(this._item.subject.uri);
            if (isFavorite) {
                this._favs.deleteBookmarkWithUri (this._item.subject.uri);
                this._source.actor.destroy();
            } else {
                this._favs.append (this._item.subject.uri);
            }
            */
        } else if (child == this._showItemInManager) {
            Util.spawn(['nautilus', this._item.subject.uri]);
            Main.overview.hide();
        } else if (child == this._showItemsInManager) {
            this._launchItemsInManager(selections);
        } else if (child == this._moveFileToTrash) {
            // remove the item from journal after trashing, it'll be recuperated
            // as a new event by the Trash filter
            let uri = this._item.subject.uri;
            try {
              let file = Gio.file_new_for_uri(uri);
              file.trash(null);
            } catch(e) {
              Util.spawn(['gvfs-trash', uri]);
            }
            this._source._removeItem();
        } else if (child == this._moveFilesToTrash) {
            this._moveItemsToTrash(selections);
        } else if (child == this._startConversation) {
            this._telepathyConversationLaunch(this._item.subject.origin, this._item.subject.uri);
            //Util.spawn(['empathy', this._item.subject.uri]);
        }
        this.close();
        this._source.multiSelect.destroy ();
    },


    _telepathyConversationLaunch: function(account_id, contact_id) {
        let props = {};
        //let dbus = Tp.DBusDaemon.dup();
        let account_manager = new Tp.AccountManager.dup();

        let account = account_manager.ensure_account(account_id);
        
        props[Tp.PROP_CHANNEL_CHANNEL_TYPE] = Tp.IFACE_CHANNEL_TYPE_TEXT;
        props[Tp.PROP_CHANNEL_TARGET_HANDLE_TYPE] = Tp.HandleType.CONTACT; 
        props[Tp.PROP_CHANNEL_TARGET_ID] = contact_id; 

        let req = new Tp.AccountChannelRequest(account, props, global.get_current_time());

        req.ensure_channel_async('', null, null);
    }, 

    // TOO REDUNDANT FIXME

    _launchItemsInManager: function(elements) {
        if (elements.length > 1) {
            for (let i = 0; i < elements.length; i++) {
                let e = elements[i];
                Util.spawn(['nautilus', e.item.subject.origin]);
            }
        } else {
            Util.spawn(['nautilus', this._item.subject.origin]);
            Main.overview.hide ();
        }
    },

    _moveItemsToTrash: function(elements) {
        if (elements.length > 1) {
            for (let i = 0; i < elements.length; i++) {
                let e = elements[i];
                let uri = e.item.subject.uri;
                try {
                  let file = Gio.file_new_for_uri(uri);
                  file.trash(null);
                } catch(e) {
                  Util.spawn(['gvfs-trash', uri]);
                }
                this._source._removeItem();
            }
        }
    }

};



//*** HeadingItem ***
//
// A simple label for the date block headings in the journal, i.e. the
// labels that display each day's date.

function HeadingItem (label_text) {
    this._init (label_text);
}

HeadingItem.prototype = {
    _init: function (label_text) {
        this._label_text = label_text;
        this.actor = new St.Label ({ text: this._label_text.toUpperCase(),
            style_class: 'journal-heading',});
    }
};


//*** Utility functions

function _compareEventsByTimestamp (a, b) {
    if (a.timestamp < b.timestamp)
        return -1;
    else if (b.timestamp > a.timestamp)
        return 1;
    else
        return 0;
}

function _deleteEvents(subject_text) {
    let subject = new Zeitgeist.Subject ("", "", "", "", "", subject_text, "");
    let event_template = new Zeitgeist.Event ("", "", "", [subject], "");
    Zeitgeist.findEventIds([0, 9999999999999], 
          [event_template], 
          Zeitgeist.StorageState.ANY, 
          0, 
          0,
          Lang.bind (this, function (events) {
              Zeitgeist.deleteEvents(events);    
          }));
    return;
}

function getMethods(obj) {
    for(var m in obj) {
        log(m);
    }
}

function _deleteArrayElement(array, element) {
    for (let i = 0; i < array.length; i++) {
        if (array[i] == element) {
            array.splice(i, 1);
            break;
        }
    }
    return array;
}


////////////////////////////////////////////////////////////////////////////////
////////////////////////////////////////////////////////////////////////////////


function SubJournal (label, timerange, template, sorting, multi_select, subjects, expandable) {
    this._init (label, timerange, template, sorting, multi_select, subjects, expandable);
}

SubJournal.prototype = {
    _init: function (label, timerange, template, sorting, multi_select, subjects, expandable) {
        this._expandable = expandable;
        this._item_limit = 5;
        this._subjects = subjects;
        this._items = [];
        this._events = [];
        this._timerange = timerange;
        this._template = template;
        this._sorting = sorting;
        this._multi_select = multi_select;
        this._itemSpacing = 37; // "item-spacing" attribute
        this._rowSpacing = 8;  // "row-spacing" attribute11
        this._box = new St.BoxLayout({vertical: true });
        this._container = new Shell.GenericContainer ();
        this._container.connect ("style-changed", Lang.bind (this, this._styleChanged));
        this._container.connect ("allocate", Lang.bind (this, this._allocate));
        this._container.connect ("get-preferred-width", Lang.bind (this, this._getPreferredWidth));
        this._container.connect ("get-preferred-height", Lang.bind (this, this._getPreferredHeight));
        //this._container.add_actor(label.actor);
        this._header = new St.BoxLayout({ vertical: false, style_class: 'journal-heading-box'});
        this._box.add_actor (this._header, { x_align: St.Align.START, y_align: St.Align.START, expand: true, x_fill: true, y_fill: false });
        this._box.add_actor (this._container, { expand: true, x_fill: true, y_fill: true});
        this.actor = this._box;
        this._label = label;
        this._inserted_items = [];
        this._expanded = false;
        
        
        this.refresh();
    },
    
    
    refresh : function () {
        this._items = []
        
        var widgets = this._container.get_children();
        for (var i = 0; i < widgets.length; i++)
        {
            this._container.remove_actor(widgets[i]);
        }
        var widgets = this._header.get_children();
        for (var i = 0; i < widgets.length; i++)
        {
            this._header.remove_actor(widgets[i]);
        }
        
        
        var heading = new HeadingItem(this._label);
        
        //this.appendItem (heading);
        
        this._header.add_actor(heading.actor, {x_align: St.Align.START, y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
        
        Zeitgeist.findEvents (this._timerange,            // time_range
                              [this._template],           // event_templates
                              Zeitgeist.StorageState.ANY, // storage_state - FIXME: should we use AVAILABLE instead?
                              0,                          // num_events - 0 for "as many as you can"
                              this._sorting, // result_type
                              Lang.bind (this, this._appendEvents));
    },
    
    _appendEvents: function(events) {
        //this._subjects = {} //FIXME: we cant just remove the subjects 
        this.actor.hide();
        this._events = events;
        var inserted = 0;
        this._inserted_items = [];
        //log ("got " + events.length + " events");
        if (!this._expandable)
            this._item_limit = 999;
        for (let i = 0; i < events.length; i++) {
            let e = events[i];
            let subject = e.subjects[0];
            let uri = subject.uri.replace('file://', '');
            uri = GLib.uri_unescape_string(uri, '');
            if (GLib.file_test(uri, GLib.FileTest.EXISTS) || subject.origin.indexOf("Telepathy") != -1) {
                if (this._subjects[uri] == undefined)
                    this._subjects[uri] = {"uri": uri, "journal": this, "item": null, "event": e};
                var allow_insertion = false;
                if (inserted >= this._item_limit) {
                    if (this._subjects[uri]["item"] == null) {
                        inserted = inserted +1;
                        this._inserted_items.push(e);
                    }
                    continue;
                }
                let item = new EventItem (e, this._multi_select, this);
                if (this._subjects[uri]["item"] == null) {
                    this._subjects[uri]["item"] = item;
                    allow_insertion = true;
                }
                else if (item._item_info.timestamp > this._subjects[uri]["event"].timestamp
                    || this._subjects[uri]["journal"] == this) {
                    //log("---> found " + uri + " in other container");
                    // FIXME: remove item from other journal
                    // this._subjects[uri]["timestamp"] = e.timestamp
                    allow_insertion = true;
                }
                if (allow_insertion) {
                    this._inserted_items.push(e);
                    inserted = inserted +1;
                    if (inserted <= this._item_limit) {
                        this.appendItem (item);
                        this.appendHSpace ();
                    }
                }
            }
        }
        
        
        if (inserted > 0)
            this.actor.show();
        
        //[arg, func] = SubjCategories[this._label] ;
        if (this._expandable) {
            if (!(this._label in SubjCategories) && inserted > this._item_limit){
                this._moreButton = new St.Button({ label: GLib.markup_escape_text (
                    "(Show " + (this._inserted_items.length - this._item_limit) + " items...)", -1),
                                         style_class: 'journal-heading',
                                         y_align: St.Align.START,
                                         x_align: St.Align.START,
                                         can_focus: true });
                this._header.add(this._moreButton, {x_align: St.Align.START, y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
                
                this._moreButton.connect('clicked', Lang.bind(this, function() {
                    this._toggleMore();
                }));
            }
            else if (this._label in SubjCategories) {
                this._moreButton = new St.Button({ 
                    label: GLib.markup_escape_text ("(Show More...)", -1),
                    style_class: 'journal-heading',
                    x_align: St.Align.START,
                    y_align: St.Align.START,
                    can_focus: true });
                this._header.add(this._moreButton, {x_align: St.Align.START, y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
                
                this._moreButton.connect('clicked', Lang.bind(this, function() {
                    [arg, func] = SubjCategories[this._label];
                func._selectCategory(arg);
                }));
            }
        }
    },
    
    _toggleMore: function () {
        this._expanded = !this._expanded;
        if (this._expanded) {
            this._moreButton.set_label("(Show fewer items)");
            this._item_limit = 999;
        }
        else {
            this._item_limit = 5;
            this._moreButton.set_label("(+ " + (this._inserted_items.length - this._item_limit) + " items...)")
        }
        
        var widgets = this._container.get_children();
        this._items = []
        for (var i = 0; i < widgets.length; i++)
        {
            this._container.remove_actor(widgets[i]);
            widgets[i].destroy();
        }
        
        this._appendEvents(this._events);
    },
    
    _styleChanged: function () {
        for (var key in this._containers)
        {
            let node = this._containers[key].get_theme_node ();

            this._itemSpacing = node.get_length ("item-spacing");
            this._rowSpacing = node.get_length ("row-spacing");

            this._containers[key].queue_relayout ();
        }
    },
    
    _allocate: function (actor, box, flags) {
        let width = box.x2 - box.x1;
        this._computeLayout (width, true, flags);
    },
    
    _getPreferredWidth: function (actor, forHeight, alloc) {
        alloc.min_size = 128; // FIXME: get the icon size from CSS
        alloc.natural_size = (48 + this._itemSpacing) * 4 - this._itemSpacing; // four horizontal icons and the spacing between them
    },

    _getPreferredHeight: function (actor, forWidth, alloc) {
        let height = this._computeLayout (forWidth, true, null);
        alloc.min_size = height;
        alloc.natural_size = height;
    },

    _computeLayout: function (available_width, do_allocation, allocate_flags) {
        let layout_state = { newline_goal_column: 0,
                             x: 0,
                             y: 0,
                             row_height : 0,
                             layout_width: available_width };

        let newline = Lang.bind (this, function () {
            layout_state.x = layout_state.newline_goal_column;
            layout_state.y += layout_state.row_height + this._rowSpacing;
            layout_state.row_height = 0;
        });

        for (let i = 0; i < this._items.length; i++) {
            let item = this._items[i];
            let item_layout = { width: 0, height: 0 };

            if (item.type == "item") {
                if (!item.child)
                    throw new Error ("internal error - item.child must not be null");

                item_layout.width = item.child.actor.get_preferred_width (-1)[1]; // [0] is minimum width; [1] is natural width
                item_layout.height = item.child.actor.get_preferred_height (item_layout.width)[1];
            } else if (item.type == "newline") {
                newline ();
                continue;
            } else if (item.type == "hspace") {
                item_layout.width = this._itemSpacing;
            }

            if (layout_state.x + item_layout.width > layout_state.layout_width) {
                newline ();

                if (item.type == "hspace")
                    continue;
            }

            let box = new Clutter.ActorBox ();
            box.x1 = layout_state.x;
            box.y1 = layout_state.y;
            box.x2 = box.x1 + item_layout.width;
            box.y2 = box.y1 + item_layout.height;
            
            if (item.type == "item" && do_allocation && allocate_flags != null)
            {
                item.child.actor.allocate (box, allocate_flags);
            }

            layout_state.x += item_layout.width;
            if (item_layout.height > layout_state.row_height)
                layout_state.row_height = item_layout.height;
        }

        return layout_state.y + layout_state.row_height;
    },
    
    // We only expect items to have an item.actor field, which is a ClutterActor
    appendItem: function (item) {
        if (!item)
            throw new Error ("item must not be null");
        if (!item.actor)
            throw new Error ("Item must already contain an actor when added to the JournalLayout");
        let i = { type: "item",
                  child: item };
        this._items.push (i);
        this._container.add_actor (item.actor);
    },

    appendNewline: function () {
        let i = { type: "newline" }
        this._items.push (i);
    },

    appendHSpace: function () {
        let i = { type: "hspace" };
        this._items.push (i);
    },
    
    removeItem: function (item) {
        for (var i = 0; i < this._items.length; i++) {
            if (this._items[i].type == 'item' && this._items[i].child == item)
            {
                this._items.splice(i, i+1);
                log("-------------------------------------"); 
                break;
            }
        } 
    }
    
}

function JournalLayout () {
    this._init ();
}

JournalLayout.prototype = {
    _init: function () {
        this._items = []; // array of { type: "item" / "newline" / "hspace", child: item }
        //this._container = new Shell.GenericContainer ({ style_class: 'journal' });

        //this._container.connect ("style-changed", Lang.bind (this, this._styleChanged));
        this._itemSpacing = 0; // "item-spacing" attribute
        this._rowSpacing = 0;  // "row-spacing" attribute

        // We pack the Shell.GenericContainer inside a box so that it will be scrollable.
        // Shell.GenericContainer doesn't implement the StScrollable interface,
        // but St.BoxLayout does.
        this._box = new St.BoxLayout({name: 'searchResultsContent', vertical: true});
        this.actor = this._box;
        //this._container.connect ("allocate", Lang.bind (this, this._allocate));
        //this._container.connect ("get-preferred-width", Lang.bind (this, this._getPreferredWidth));
        //this._container.connect ("get-preferred-height", Lang.bind (this, this._getPreferredHeight));
        this._containers = {}
    },

    _setUpTimeViews: function (timeview, category) {
        this.clear()
        var end = new Date().getTime();
        let template = category.event_template;
        let offset = category.time_range;
        let sorting = category.sorting;
        
        let multi_select = new MultiSelect ();
        let uri_map = {}
        
        if (timeview == false) {
            if (offset > 0)
                start = end - offset
            else
                start = 0
                
            template.subjects[0].interpretation = Semantic.NFO_DOCUMENT;
            this._containers["Documents"] = new SubJournal ("Documents", 
                [start, end], eval(uneval(template)), sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Documents"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            template.subjects[0].interpretation = Semantic.NFO_AUDIO;
            this._containers["Music"] = new SubJournal ("Music", 
                [start, end], eval(uneval(template)), sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Music"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            template.subjects[0].interpretation = Semantic.NFO_VIDEO;
            this._containers["Videos"] = new SubJournal ("Videos",
                [start, end], eval(uneval(template)), sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Videos"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            template.subjects[0].interpretation = Semantic.NFO_IMAGE;
            this._containers["Pictures"] = new SubJournal ("Pictures", 
                [start, end], eval(uneval(template)), sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Pictures"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            let subjects = []
            var interpretations = [
                '!' + Semantic.NFO_IMAGE,
                '!' + Semantic.NFO_DOCUMENT,
                '!' + Semantic.NFO_VIDEO,
                '!' + Semantic.NFO_AUDIO,
                '!' + Semantic.NMM_MUSIC_PIECE];
            for (let i = 0; i < interpretations.length; i++) {
                let subject = new Zeitgeist.Subject(template.subjects[0].uri, interpretations[i], '', '', '', '', '');
                subjects.push(subject);
            }
            template = new Zeitgeist.Event("", "", "", subjects, []);
            this._containers["Other"] = new SubJournal ("Other", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Other"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
        }
        
        else{
            var start = end - 86400000
            this._containers["Today"] = new SubJournal ("Today", 
                [start, end], template, sorting, multi_select, uri_map, false);
            this._box.add_actor (this._containers["Today"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            end = start
            start = end - 86400000
            this._containers["Yesterday"] = new SubJournal ("Yesterday", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Yesterday"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            end = start
            start = end - 7 * 86400000
            this._containers["This Week"] = new SubJournal ("This Week", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["This Week"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            end = start
            start = end - 7 * 86400000
            this._containers["Last Week"] = new SubJournal ("Last Week", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["Last Week"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            end = start
            start = end - 14 * 86400000
            this._containers["This Month"] = new SubJournal ("This Month", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["This Month"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
            
            end = start
            start = 0
            this._containers["More Past Stuff"] = new SubJournal ("More Past Stuff", 
                [start, end], template, sorting, multi_select, uri_map, true);
            this._box.add_actor (this._containers["More Past Stuff"].actor, { y_align: St.Align.START, expand: true, x_fill: true, y_fill: true });
        }
    },

    clear: function () {
        this._items = [];
        for (var key in this._containers)
        {
            this._containers[key].actor.destroy_children();
            this._containers[key].actor.destroy();
            this.actor.destroy_children();
        }
    },
};


// FIXME: DRY the code.
function MultiSelect () {
	this._init ();
}

MultiSelect.prototype = {
	_init: function () {
		this._elements = [];
		this._multi_select = false;
	},

	select: function (source, item) {
		if (this._elements.length == 0)
			this._multi_select = true;
		else
			this._multi_select = false;

		if (this.isSelected (item) || this._multi_select) {
			let e = { source : source,
					  item: item,
					  selected: true };
			source.add_style_class_name('journal-item-selection');
			this._elements.push(e);
		} else {
			this.unselect (source, item);
		}
	},

	unselect: function (source, item) {
		source.remove_style_class_name('journal-item-selection');	
		for (let i = 0; i < this._elements.length; i++) {
			if (this._elements[i].source == source) {
				this._elements.splice(i, 1);
				break;
			}
		}
	},

	isSelected: function (item) {
		for (let i = 0; i < this._elements.length; i++) {
			let e = this._elements[i];
			if ((e.item == item) && e.selected) {
				return false;
			}
		}
		return true;
	},

	destroy: function() {
	  let elements = this._elements;
	  for (let i = 0; i < elements.length; i++) {
		  let e = elements[i];
		  e.source.remove_style_class_name('journal-item-selection');	
	  }
	  this._elements = [];
	},

	querySelections: function () {
		return this._elements;
	}
}


//*** JournalDisplay ***
//
// This carries a JournalDisplay.actor, for a timeline view of the user's past activities.
//
// Each time the JournalDisplay's actor is mapped, the journal will reload itself
// by querying Zeitgeist for the latest events.  In effect, this means that the user
// gets an updated view every time accesses the journal from the shell.
//
// So far we don't need to install a live monitor on Zeitgeist; the assumption is that
// if you are in the shell's journal, you cannot interact with your apps anyway and 
// thus you cannot create any new Zeitgeist events just yet.
let SubjCategories = {};


function JournalDisplay () {
    this._init ();
}

JournalDisplay.prototype = {
    _init: function () {
        this.box = new St.BoxLayout({style_class: 'all-app' });
        this._scroll_view = new St.ScrollView({ x_fill: false,
                                   y_fill: false,
                                   style_class: 'vfade' });
                             
        this._scroll_view.set_policy (Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC);
        this._scroll_view.connect ("notify::mapped", Lang.bind (this, this._scrollViewMapCb));
        
        this._layout = new JournalLayout ();
        
        this._filters = new St.BoxLayout({ vertical: true, reactive: true });
        this._scroll_view.add_actor(this._layout.actor, { expand: true, y_fill: true,y_align: St.Align.START, x_fill: true });
        
        this._categoryScroll = new St.ScrollView({ x_fill: false,
                                                   y_fill: false,
                                                   style_class: 'vfade' });
        this._categoryScroll.add_actor(this._filters);
        
        this.box.add(this._scroll_view, { expand: true, x_fill: true, y_fill: true });
        this.box.add_actor(this._categoryScroll, { expand: false, y_fill: false, y_align: St.Align.START  });
        
        this.actor = this.box;
        this._sections = [];
        this._setFilters();
        this._selectCategory(1);
        //this._filters.connect('scroll-event', Lang.bind(this, this._scrollFilter))
    },
    
    _scrollFilter: function(actor, event) {
        let direction = event.get_scroll_direction();
        if (direction == Clutter.ScrollDirection.UP)
            this._selectCategory(Math.max(this._currentCategory - 1, -1))
        else if (direction == Clutter.ScrollDirection.DOWN)
            this._selectCategory(Math.min(this._currentCategory + 1, this._sections.length - 1));
    },

    _selectCategory: function(num) {
        this._currentCategory = num;

        for (let i = 0; i < this._sections.length; i++) {
            if (i == num)
                this._sections[i].add_style_pseudo_class('selected');
            else
                this._sections[i].remove_style_pseudo_class('selected');
        }
        
        var b = false
        if (num > 3) 
            b= true
        this._layout._setUpTimeViews(b, this._categories[num])
    },
    
    _setFilters: function ()
    {   
        this._counter = 0;
        this._categories = [];
        this._addCategory(new NewCategory());
        this._addCategory(new RecentCategory());
        this._addCategory(new FrequentCategory());
        //this._addCategory(new StarredCategory());
        this._addCategory(new SharedCategory());
        
        var space = new St.Label ({ text: "",
                                     style_class: 'app-filter' });
        this._filters.add(space, { expand: false, x_fill: true, y_fill: false });
        
        this._addCategory(new DocumentsCategory(), true);
        this._addCategory(new MusicCategory(), true);
        this._addCategory(new VideosCategory(), true);
        this._addCategory(new PicturesCategory(), true);
        this._addCategory(new DownloadsCategory(), true);
        //this._addCategory(new ConversationsCategory());
        //this._addCategory(new MailCategory(), true);
        this._addCategory(new OtherCategory(), true);
    },
    
    _addCategory: function (category, linkable)
    {
        let button = new St.Button({ label: GLib.markup_escape_text (category.title, -1),
                                     style_class: 'app-filter',
                                     x_align: St.Align.START,
                                     can_focus: true });
        this._filters.add(button, { expand: false, x_fill: true, y_fill: false });
       
        this._sections[this._counter] = button;
        
        var x = this._counter;
        button.connect('clicked', Lang.bind(this, function() {
            this._selectCategory(x);
        }));
        this._categories.push(category);
        this._counter = this._counter + 1;
        
        if (linkable == true)
            SubjCategories[category.title] = [x, this];
    },

    _scrollViewMapCb: function (actor) {
        if (this._scroll_view.mapped)
            this._reload ();
    },
    
    _reload: function () {
        this._selectCategory(this._currentCategory)
    },
};


/*****************************************************************************/


function CategoryInterface(title) {
    this._init (title);
}

CategoryInterface.prototype = {
    _init: function (title) {
        this.title = title
        this.func = null
        this.subCategories = [];
        this.event_template = null;
        this.time_range = null;
        this.sorting = 2;
    },
};


function NewCategory() {
    this._init();
}

NewCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("New"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        this.event_template = new Zeitgeist.Event(
            "http://www.zeitgeist-project.com/ontologies/2010/01/27/zg#CreateEvent", 
            "", "", [subject], []);
        this.time_range = 60*60*3*1000;
    },
};


function RecentCategory() {
    this._init();
}

RecentCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Recently Used"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        this.event_template = new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = 86400000*7;
    },
};


function FrequentCategory() {
    this._init();
}

FrequentCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Frequent"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        this.event_template = new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = 4*86400000;
        this.sorting = 4;
    },
};


function StarredCategory() {
    this._init();
}

StarredCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Starred"));
        let subject = new Zeitgeist.Subject ("bookmark://", "", "", "", "", "", "");
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function SharedCategory() {
    this._init();
}

SharedCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Shared"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.uri = "file://"+GLib.get_user_special_dir(5)+"/*";
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function DocumentsCategory() {
    this._init();
}

DocumentsCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Documents"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.interpretation = Semantic.NFO_DOCUMENT;
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function MusicCategory() {
    this._init();
}

MusicCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Music"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.interpretation = Semantic.NFO_AUDIO;
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function VideosCategory() {
    this._init();
}

VideosCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Videos"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.interpretation = Semantic.NFO_VIDEO;
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function PicturesCategory() {
    this._init();
}

PicturesCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Pictures"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.interpretation = Semantic.NFO_IMAGE;
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function DownloadsCategory() {
    this._init();
}

DownloadsCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Downloads"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.uri = "file://"+GLib.get_user_special_dir(2)+"/*";
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function ConversationsCategory() {
    this._init();
}

ConversationsCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Conversations"));
        let subject = new Zeitgeist.Subject ("", "", "", "", "", "", "");
        subject.origin = "/org/freedesktop/Telepathy/Account/*"
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function MailCategory() {
    this._init();
}

MailCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Mail Attachments"));
        let subject = new Zeitgeist.Subject ("", "000", "", "", "", "", "");
        this.event_template =  new Zeitgeist.Event("", "", "", [subject], []);
        this.time_range = -1;
    },
};


function OtherCategory() {
    this._init();
}

OtherCategory.prototype = {
    __proto__: CategoryInterface.prototype,
    _init: function() {
        CategoryInterface.prototype._init.call(this, _("Other"));
        let subjects = []
        var interpretations = [
            '!' + Semantic.NFO_IMAGE,
            '!' + Semantic.NFO_DOCUMENT,
            '!' + Semantic.NFO_VIDEO,
            '!' + Semantic.NFO_AUDIO,
            '!' + Semantic.NMM_MUSIC_PIECE];
        for (let i = 0; i < interpretations.length; i++) {
            let subject = new Zeitgeist.Subject('', interpretations[i], '', '', '', '', '');
            subjects.push(subject);
        }
        this.event_template =  new Zeitgeist.Event("", "", "", subjects, []);
        this.time_range = -1;
    },
};


let journalView;
let viewTab;
let tabIndex;

function init(metadata)
{
    imports.gettext.bindtextdomain('gnome-shell-extensions', metadata.localedir);
}

function enable() {
    journalView = new JournalDisplay();
    Main.overview._viewSelector.addViewTab('journal', _("Journal"), journalView.actor, 'history');
    viewTab = Main.overview._viewSelector._tabs[Main.overview._viewSelector._tabs.length-1];
    tabIndex = Main.overview._viewSelector._tabs.length - 1;
}

function disable() {
    Main.overview._viewSelector._tabBox.remove_actor(viewTab.title);
    Main.overview._viewSelector._pageArea.remove_actor(viewTab.page);
    Main.overview._viewSelector._tabs.splice(tabIndex, tabIndex);
    journalView.actor.destroy();
    journalView = undefined
}
