
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
const Gio = imports.gi.Gio;
const Shell = imports.gi.Shell;
const Lang = imports.lang;
const Signals = imports.signals;
const St = imports.gi.St;
const Mainloop = imports.mainloop;

const Extension = imports.ui.extensionSystem.extensions["jump-lists@gnome-shell-extensions.gnome.org"];

const PopupMenu = imports.ui.popupMenu;
const AppDisplay = imports.ui.appDisplay;
const Main = imports.ui.main;
const Util = imports.misc.util;

const DocInfo = Extension.docInfo;
const Semantic = Extension.semantic;
const Zeitgeist = Extension.zeitgeist;

function setJumplist (appIconMenu) {
    var eventTemplate = new Zeitgeist.Event('', '', "application://" + appIconMenu._source.app.get_id(), [], []);
    
    function appendJumplist (events) {
    
        let fetchedUris = [];
        let hasJumplist = false;

        function appendJumplistItem (event, type) {
            let info = new DocInfo.ZeitgeistItemInfo(event);
            let item = new PopupMenu.PopupImageMenuItem(info.name, type);
            appIconMenu.addMenuItem(item);
            item.connect('activate', Lang.bind(appIconMenu, function () {
                let app = new Gio.DesktopAppInfo.new(appIconMenu._source.app.get_id());
                app.launch_uris([info.uri], null);
            }));
        }

        function appendEvents(events2, count, type) {
            if (count == null) {
                count = 3;
            }
            if (type == null) {
                type = "emblem-favorite";
            }
            let j = 0;

            if (events.length > 0) {
                for (let i in events) {
                    let uri = events[i].subjects[0].uri.replace('file://', '');
                    uri = uri.replace(/\%20/g, ' '); // FIXME: properly unescape, or get the display name otherwise
                    if (fetchedUris.indexOf(uri) == -1 &&
                        (GLib.file_test(uri, GLib.FileTest.EXISTS) || appIconMenu._source.app.get_id() == "tomboy.desktop")) {
                        if (!hasJumplist) {
                            appIconMenu._appendSeparator();
                            hasJumplist = true;
                        }
                        appendJumplistItem(events[i], type);
                        fetchedUris.push(uri);
                        j++;
                        if (j >= count)
                            break;
                    }
                }
            }
        }
        
        appendEvents.call(this, events, 4, "document-open-recent");
        Zeitgeist.findEvents([new Date().getTime() - 86400000*90, Zeitgeist.MAX_TIMESTAMP],
                             [eventTemplate],
                             Zeitgeist.StorageState.ANY,
                             100,
                             Zeitgeist.ResultType.MOST_POPULAR_SUBJECTS,
                             Lang.bind(appIconMenu, appendEvents));
        
    }
    
    Zeitgeist.findEvents([new Date().getTime() - 86400000*90, Zeitgeist.MAX_TIMESTAMP],
                             [eventTemplate],
                             Zeitgeist.StorageState.ANY,
                             100,
                             Zeitgeist.ResultType.MOST_RECENT_SUBJECTS,
                             Lang.bind(appIconMenu, appendJumplist));
}

function init(metadata) {
    imports.gettext.bindtextdomain('gnome-shell-extensions', metadata.localedir);
}

let origRedisplay = null;

function enable() {
    origRedisplay = AppDisplay.AppIconMenu.prototype._redisplay;
    AppDisplay.AppIconMenu.prototype._redisplay = function () {
        origRedisplay.call(this);
        setJumplist(this);
    };
}

function disable() {
    AppDisplay.AppIconMenu.prototype._redisplay = origRedisplay;
}
