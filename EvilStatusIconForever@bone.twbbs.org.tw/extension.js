/*****************************************************
 * Statuc Icon Settings
 ****************************************************/

//
// Add application you want it shows thier notification status
// icon on top bar to the following list.
//
// You may use top/htop to find out the name of application.
//

var notification = [
    'deadbeef',     // Deadbeef Music Player
    'pidgin',       // Pidgin IM Client
    'gcin',         // GCIN Chinese Input Method
    'hime'          // HIME Imput Method Editor
]


// Add which built-in status icon you want to remove in the
// following list.
//

var removeStatusIcon = [
    'a11y',         // Accessibility
    // 'volume',
    // 'battery',
    // 'keyboard',
    // 'bluetooth',
    // 'network'
]

/******************************************************
 * Don't touch anything below!
 *****************************************************/

const StatusIconDispatcher = imports.ui.statusIconDispatcher;
const Panel = imports.ui.panel;
const Main = imports.ui.main;

/**
 *  Hide built-in status icon.
 */
function hideStatusIcon(name)
{
    for (var i = 0; i < Main.panel._rightBox.get_children().length; i++) {
        if (Main.panel._statusArea[name] == 
            Main.panel._rightBox.get_children()[i]._delegate) {
            global.log("HIDE:" + name);
            Main.panel._rightBox.get_children()[i].hide();
            break;
        }
    }
}

/**
 *  Show built-in status icon again.
 */
function showStatusIcon(name)
{
    for (var i = 0; i < Main.panel._rightBox.get_children().length; i++) {
        if (Main.panel._statusArea[name] == 
            Main.panel._rightBox.get_children()[i]._delegate) {
            global.log("SHOW:" + name);
            Main.panel._rightBox.get_children()[i].show();
            break;
        }
    }
}

function removeFromTopBar(wmClass)
{
    delete StatusIconDispatcher.STANDARD_TRAY_ICON_IMPLEMENTATIONS[wmClass];
}

function addToTopBar(wmClass)
{
    StatusIconDispatcher.STANDARD_TRAY_ICON_IMPLEMENTATIONS[wmClass] = wmClass;
}

function init() {
}

function enable() {

    for (var i = 0; i < notification.length; i++) {
        global.log('Add ' + notification[i] + " to top bar");
        addToTopBar(notification[i]);
    }

    for (var i = 0; i < removeStatusIcon.length; i++) {
        global.log('Remove ' + removeStatusIcon[i] + " from top bar");
        hideStatusIcon(removeStatusIcon[i]);
    }

}

function disable() {

    for (var i = 0; i < notification.length; i++) {
        global.log('Remove ' + notification[i] + " from top bar");
        removeFromTopBar(notification[i]);
    }

    for (var i = 0; i < removeStatusIcon.length; i++) {
        global.log('Restore ' + removeStatusIcon[i] + " to top bar");
        showStatusIcon(removeStatusIcon[i]);
    }

}

