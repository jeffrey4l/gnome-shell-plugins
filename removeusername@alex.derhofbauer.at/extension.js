const Main = imports.ui.main;

function init() {
}

function disable() {
    Main.panel._statusArea['userMenu']._name.show();
}

function enable() {
    Main.panel._statusArea['userMenu']._name.hide();
}

