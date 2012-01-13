
const St = imports.gi.St;
const Main = imports.ui.main;

let thumbnails=[], texts=[];
let oldNumThumbnails=0, numThumbnails=0;
let showID, hideID;

let _nanoUtils = {
	
	returnTrue: function () {
		return true;
	},
	
	hideLabels: function () {
		for ( var i = 0; i < numThumbnails; i++)
	    	thumbnails[i]._contents.remove_actor(texts[i]);
	},
	
	showLabels: function () {
    	let windows  = global.get_window_actors();
		for (var i = 0; i < numThumbnails; i++) {
	    	let aText = texts[i];
	    	thumbnails[i]._contents.add_actor(aText);
	    	for (var j = 0; j < windows.length; j++)
		    	if (windows[j].meta_window.get_workspace().index() == i) {
		    		let title = windows[j].meta_window.get_title();
		    		aText.set_hint_text(title);
		    		break;
		    	}
	    }
	},
	
	toggleLabels: function () {
		// we ignore the last empty workspace in our calculations
		thumbnails = Main.overview._workspacesDisplay._thumbnailsBox._thumbnails;
		numThumbnails = thumbnails.length - 1;
		
		//Main._logDebug('old:'+oldNumThumbnails+' new:'+numThumbnails);
		// This will be used to support workspaces changing in the overview in the future
		/*  
		if (oldNumThumbnails > numThumbnails)
	    	thumbnails[numThumbnails-1]._contents.remove_actor(texts[numThumbnails-1]);
		else
			_nanoUtils.showLabels();
		*/
			
		_nanoUtils.showLabels();
		oldNumThumbnails = numThumbnails;
	}
}






function init() {
    // Allocate MAX_WORKSPACES amount of entry actors
    let monitor = Main.layoutManager.primaryMonitor;
	for (var i = 0; i < 16; i++) {
		let exo = texts[i] = new St.Entry({ style_class: 'nano-label',                           
		                          			reactive: true});
		                          		
		// prevent entering the workspace when trying to enter a label
    	exo.connect('button-release-event', _nanoUtils.returnTrue);
    	
    	// show label at bottom of workspace
    	exo.opacity = 230;
    	exo.set_position(0, Math.floor(.75*monitor.height));
		exo.set_size(Math.floor(monitor.width), Math.floor(.25*monitor.height));
	}
}

function enable() {
    showID = Main.overview.connect('showing', _nanoUtils.toggleLabels);
    hideID = Main.overview.connect('hiding', _nanoUtils.hideLabels);
}

function disable() {
    Main.overview.disconnect(showID);
    Main.overview.disconnect(hideID);
    
    // remove labels the next time the overview is 'showing'
    let finalID = Main.overview.connect('showing', function () {
    	// predicate is set if overview was shown
    	if (oldNumThumbnails)
    		_nanoUtils.hideLabels();
		this.disconnect(finalID);
    });
}
