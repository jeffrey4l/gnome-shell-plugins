const Main = imports.ui.main;
const Lang = imports.lang;
const DBus = imports.dbus;
const Tp = imports.gi.TelepathyGLib;
const UserMenu = imports.ui.userMenu;
const IMStatus = UserMenu.IMStatus;

let UserMenuButton = Main.panel._statusArea.userMenu;

const PurpleIface = {
    name: 'im.pidgin.purple.PurpleInterface',
    properties: [],
    methods: [
        {name: 'PurpleSavedstatusNew', inSignature: 'si', outSignature: 'i'},
        {name: 'PurpleSavedstatusGetCurrent', inSignature: '', outSignature: 'i'},
        {name: 'PurpleSavedstatusGetType', inSignature: 'i', outSignature: 'i'},
        {name: 'PurpleSavedstatusGetMessage', inSignature: 'i', outSignature: 's'},
        {name: 'PurpleSavedstatusSetMessage', inSignature: 'is', outSignature: ''},
        {name: 'PurpleSavedstatusActivate', inSignature: 'i', outSignature: ''},
        {name: 'PurplePrimitiveGetIdFromType', inSignature: 'i', outSignature: 's'},
        {name: 'PurplePrimitiveGetTypeFromId', inSignature: 's', outSignature: 'i'},
    ],
    signals: [
        {name: 'SavedstatusChanged', inSignature: 'ii'},
    ]
};

let Purple = DBus.makeProxyClass(PurpleIface);

function PurpleClient(box) {
    this._init(box);
}

PurpleClient.prototype = {
    _init: function(menu) {
        this._menu = menu;
        this._menu._IMStatusChanged(undefined, 'offline', undefined, undefined);
        this._menuToggle(false);
        DBus.session.watch_name('im.pidgin.purple.PurpleService', false, Lang.bind(this, this._onPurpleAppeared), Lang.bind(this, this._onPurpleVanished));
    },
    
    _onPurpleAppeared: function(owner) {
        this._menuToggle(true);
        this._proxy = new Purple(DBus.session, 'im.pidgin.purple.PurpleService', '/im/pidgin/purple/PurpleObject');
        this._savedstatusChangeId = this._proxy.connect('SavedstatusChanged', Lang.bind(this, this._onSavedstatusChange));
        this._proxy.PurpleSavedstatusGetCurrentRemote(Lang.bind(this, function(status_id) {
            this._onSavedstatusChange(undefined, status_id, undefined);
        }));
    },
    
    _onPurpleVanished: function(oldOwner) {
        this._menu._IMStatusChanged(undefined, 'offline', undefined, undefined);
        this._menuToggle(false);
    },

    _menuToggle: function(show) {
        for (let i = 0; i < IMStatus.LAST; i++) {
            this._menu._combo.setItemVisible(i, show || i == IMStatus.OFFLINE);
        }
    },
    
    _onSavedstatusChange: function (emitter, new_savedstatus_id, old_savedstatus_id) {
        this._proxy.PurpleSavedstatusGetTypeRemote(new_savedstatus_id, Lang.bind(this, function(type) {
            this._proxy.PurplePrimitiveGetIdFromTypeRemote(type, Lang.bind(this, function(presence) {
                this._menu._IMStatusChanged(undefined, presence, undefined, undefined);
            }));
        }));
    },
}

function IMStatusChooserItem() {
    this._init();
}

IMStatusChooserItem.prototype = {
    __proto__: UserMenu.IMStatusChooserItem.prototype,

    _init: function() {
        UserMenu.IMStatusChooserItem.prototype._init.call (this);
        
        this._purpleClient = new PurpleClient(this);
    },

    _IMStatusChanged: function(accountMgr, presence, status, message) {
        if (presence == 'available' || presence == 'freeforchat')
            presence = Tp.ConnectionPresenceType.AVAILABLE;
        else if (presence == 'unavailable')
            presence = Tp.ConnectionPresenceType.BUSY;
        else if (presence == 'invisible')
            presence = Tp.ConnectionPresenceType.HIDDEN;
        else if (presence == 'away')
            presence = Tp.ConnectionPresenceType.AWAY;
        else if (presence == 'extended_away')
            presence = Tp.ConnectionPresenceType.EXTENDED_AWAY;
        else if (presence == 'offline')
            presence = Tp.ConnectionPresenceType.OFFLINE;
        else
            return;
        
        UserMenu.IMStatusChooserItem.prototype._IMStatusChanged(this, undefined, presence, undefined, undefined);
        UserMenuButton._updatePresenceIcon(undefined, presence, undefined, undefined);
    },

    _changeIMStatus: function(menuItem, id) {
        let newPresence, status;
        
        if (id == IMStatus.AVAILABLE) {
            newPresence = Tp.ConnectionPresenceType.AVAILABLE;
            status = 'available';
        } else if (id == IMStatus.BUSY) {
            newPresence = Tp.ConnectionPresenceType.BUSY;
            status = 'unavailable';
        } else if (id == IMStatus.HIDDEN) {
            newPresence = Tp.ConnectionPresenceType.HIDDEN;
            status = 'invisible';
        } else if (id == IMStatus.AWAY) {
            newPresence = Tp.ConnectionPresenceType.AWAY;
            status = 'away';
        } else if (id == IMStatus.IDLE) {
            newPresence = Tp.ConnectionPresenceType.EXTENDED_AWAY;
            status = 'extended_away';
        } else if (id == IMStatus.OFFLINE) {
            newPresence = Tp.ConnectionPresenceType.OFFLINE;
            status = 'offline';
        } else
            return

        this._purpleClient._proxy.PurpleSavedstatusGetCurrentRemote(Lang.bind(this, function(current_savedstatus_id) {
            this._purpleClient._proxy.PurplePrimitiveGetTypeFromIdRemote(status, Lang.bind(this, function(type) {
                this._purpleClient._proxy.PurpleSavedstatusGetMessageRemote(current_savedstatus_id, Lang.bind(this, function(message) {
                    this._purpleClient._proxy.PurpleSavedstatusNewRemote('', type, Lang.bind(this, function(new_savedstatus_id) {
                        this._purpleClient._proxy.PurpleSavedstatusSetMessageRemote(new_savedstatus_id, message);
                        this._purpleClient._proxy.PurpleSavedstatusActivateRemote(new_savedstatus_id);
                    }));
                }));
            }));
        }));
        UserMenuButton._updatePresenceIcon(undefined, newPresence, undefined, undefined);
    },

    _setComboboxPresence: function(presence) {
        let activatedItem;

        if (presence == Tp.ConnectionPresenceType.AVAILABLE)
            activatedItem = IMStatus.AVAILABLE;
        else if (presence == Tp.ConnectionPresenceType.BUSY)
            activatedItem = IMStatus.BUSY;
        else if (presence == Tp.ConnectionPresenceType.HIDDEN)
            activatedItem = IMStatus.HIDDEN;
        else if (presence == Tp.ConnectionPresenceType.AWAY)
            activatedItem = IMStatus.AWAY;
        else if (presence == Tp.ConnectionPresenceType.EXTENDED_AWAY)
            activatedItem = IMStatus.IDLE;
        else if (presence == Tp.ConnectionPresenceType.OFFLINE)
            activatedItem = IMStatus.OFFLINE;
        else
            return;

        this._combo.setActiveItem(activatedItem);
    },
}

function init() {
}

function enable() {
    UserMenuButton.menu._getMenuItems()[0].destroy();

    let item = new IMStatusChooserItem();
    item.connect('activate', Lang.bind(UserMenuButton, UserMenuButton._onMyAccountActivate));
    UserMenuButton.menu.addMenuItem(item, 0);
}

function disable() {
    UserMenuButton.menu._getMenuItems()[0].destroy();

    let item = new UserMenu.IMStatusChooserItem();
    item.connect('activate', Lang.bind(UserMenuButton, UserMenuButton._onMyAccountActivate));
    UserMenuButton.menu.addMenuItem(item, 0);
}
