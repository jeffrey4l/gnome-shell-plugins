const St = imports.gi.St;
const Main = imports.ui.main;
const Panel = imports.ui.panel;

let activitiesButtonLabel, activitiesButton, label;

function init(metadata) {
	activitiesButton = Main.panel._activitiesButton;
	activitiesButtonLabel = activitiesButton._label.get_text();
	label = metadata.label;
}
 
function enable() {
	activitiesButton._label.set_text(label);
}
 
function disable() {
	activitiesButton._label.set_text(activitiesButtonLabel);
}

