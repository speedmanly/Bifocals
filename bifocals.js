/*
* bifocals.js
* Copyright(c) 2012 Aaron Hedges <aaron@dashron.com>
* MIT Licensed
*/
"use strict";

var EventEmitter = require('events').EventEmitter;
var util_module = require('util');
var http_module = require('http');

var _renderers = {};

/**
 * Registers a renderer object to a content type
 * @param {string} content_type The content type (or mime type) of the request
 * @param {Renderer} renderer     The renderer object that will handle view data
 */
exports.addRenderer = function addRenderer(content_type, renderer) {
	_renderers[content_type] = renderer;
};

/**
 * Returns a renderer for a content type
 * @param  {string} content_type The content type (or mime type) of the request
 * @return {Renderer}              The renderer associated with the content type
 * @throws {Error} If a renderer has not been added to the content_type
 */
exports.getRenderer = function getRenderer(content_type) {
	if (_renderers[content_type]) {
		return _renderers[content_type];
	} else {
		throw new Error('Unsupported content type :' + content_type);
	}
};

var render_states = exports.RENDER_STATES = {
	RENDER_NOT_CALLED : 0,
	RENDER_REQUESTED : 1,
	RENDER_STARTED : 2,
	RENDER_COMPLETE : 3,
	RENDER_FAILED : 4,
	RENDER_CANCELED : 5
};

/**
 * Renders templates with many output options, and unlimited asynchronous sub views
 * 
 * USAGE:
 * //Templates:
 * templates/index.html
 * <html>
 *  <head></head>
 *  <body>
 *   {{{header}}}
 *  </body>
 * </html>
 * 
 * templates/header.html
 * <header>
 * {{title}}
 * </header>
 * 
 * 
 * //Create the parent:
 * var view = new Bifocals("templates/index.html");
 * view.response = response;
 * 
 * //Create the child:
 * var child = template.child("header", "templates/header.html");
 * child.set('title, "Hello World");
 * 
 * //Write the view to the response
 * view.render();
 * 
 * //And you are done! You don't have to tell the child views to render, that is all handled for you.
 * 
 * @author Aaron Hedges <aaron@dashron.com>
 */
var Bifocals = exports.Bifocals = function Bifocals() {
	EventEmitter.call(this);

	this._child_views = {};
	this._data = {};

	this.render_state = render_states.RENDER_NOT_CALLED;
	this.parent = null;
	this.root = this;
};

util_module.inherits(Bifocals, EventEmitter);

Bifocals.prototype._data = null;
Bifocals.prototype._child_views = null;

/**
 * The response object that the renderer will write to
 * Changing this will alter how render is performed.
 * It is not recommended to change this on child views, only parent views.
 * Child views use an object with some functions matching ServerResponse, but it is not a ServerResponse.
 * Only the root element should have a ServerResponse
 * 
 * @type {ServerResponse|Object}
 */
Bifocals.prototype.response = null;

/**
 * Error handler, any time an error occurs it will be provided to this function. Can be overridden via Bifocals.error(fn);
 * 
 * @param  {Error} error
 */
Bifocals.prototype._error = function bifocals_defaultError(error) {
	console.log(error);
	throw new Error('No error handler has been assigned to this view. Are one of your status calls erroring (404, 500, etc?). Maybe you have not set an error handler for your root template');
};

/**
 * The content type (or mime type) of the response. This is used to locate the proper renderer, and sent via headers to the client
 * Changing this will change the object used to render the final output
 * 
 * @type {String}
 */
Bifocals.prototype.content_type = null;

/**
 * The template that the view should render when complete. This is provided to the renderer along with the dir.
 * Changing this will override any previously assigned templates, and will be counted as an override for any template provided to a render call.
 * 
 * @type {String}
 */
Bifocals.prototype.template = null;

/**
 * The default directory that this view should use to locate templates
 * Changing this changes which directory templates will be loaded from when the view is done rendering
 * 
 * @type {String}
 */
Bifocals.prototype.dir = null;

/**
 * The Bifocal view that created this view as a child.
 * Changing this will alter what happens when a child element finishes rendering. On success, a child element attempts to render it's parent element.
 * 
 * @type {Bifocal}
 */
Bifocals.prototype.parent = null;

/**
 * The root Bifocal view in the chain of parent child views (aka the original view)
 * Changing this will alter what view this child will send status codes and headers too.
 * 
 * @type {Bifocal}
 */
Bifocals.prototype.root = null;

/**
 * The current state of the bifocal object, can be one of the following.
 * module.RENDER_NOT_CALLED, module.RENDER_REQUESTED, module.RENDER_STARTED,
 * module.RENDER_COMPLETE, module.RENDER_FAILED, module.RENDER_CANCELED
 * @type {Number}
 */
Bifocals.prototype.render_state = null;

/**
 * returns whether the view has finished rendering or not
 * 
 * @returns {Boolean}
 */
Bifocals.prototype.isRendered = function bifocals_isRendered() {
	return this.render_state === render_states.RENDER_COMPLETE;
};

/**
 * Sets data to be rendered to the view
 * 
 * @param {String} key
 * @param {mixed} value
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.set = function bifocals_set(key, value) {
	this._data[key] = value;
	return this;
};

/**
 * Retrieves all of the data so that it can be rendered by a parent
 * 
 * @param {String} key
 * @return {Mixed|Object}
 */
Bifocals.prototype.get = function bifocals_get(key) {
	if(typeof key === "string") {
		return this._data[key];
	}
	return this._data;
};

/**
 * If the view is ready to be rendered, this will be true, otherwise false
 * 
 * @returns {Boolean}
 */
Bifocals.prototype.canRender = function bifocals_canRender() {
	var key = null;

	/**
	 * This protects from items rendering in random async order
	 * example 1:
	 * parent creates child, loads data from database, then renders.
	 * child immediately renders
	 * - in this example, the child is complete first, and checks if the parent can render.
	 *    Render has not been requested, so it fails. Once the parent calls render() everything works fine
	 * 
	 * example 2:
	 * Parent creates child, then immediately renders
	 * child loads data from database then renders.
	 * - in this example, the parent is complete first, so it marks render as requested but notices child views exist
	 *    Because of this, it waits. Once the child view renders it notices that the parent is ready and immediately calls parent.render()
	 */  
	if (this.render_state !== render_states.RENDER_REQUESTED) {
		return false;
	}

	for(key in this._child_views) { 
		if(!this._child_views[key].isRendered()) {
			return false;
		}
	}
	return true;
};

/**
 * Renders the current view, writing the the response, if and only if all child views have been completed
 * 
 * @param {String} template Renders the provided template unless one was set previously.
 * @param {Boolean} force Kills all child elements and forces the template to be rendered immediately. default: false
 */
Bifocals.prototype.render = function bifocals_render(template, force) {
	if (!force) {
		// If rendering has been canceled before we try to render, do nothing
		if (this.render_state === render_states.RENDER_CANCELED) {
			return;
		}

		this.render_state = render_states.RENDER_REQUESTED;

		if (this.canRender()) {
			this.render_state = render_states.RENDER_STARTED;
			// We want to prefer the pre-set template over the render(template)
			if (this.template) {
				template = this.template;
			}
			this.buildRenderer().render(this.dir + template);
		} else {
			// If a template has not yet been assigned to this view, and we can not immediately render it
			// we need to set the provided template, so it is rendered in the future
			if (!this.template) {
				this.template = template;
			}
		}
	} else {
		this.cancelRender();
		this.render_state = render_states.RENDER_REQUESTED;
		this.template = template;
		this.render(template, false);
	}
};

/**
 * Stops a render from occurring, and attempts to stop all child elements too.
 */
Bifocals.prototype.cancelRender = function bifocals_cancelRender() {
	var key = null;
	this.render_state = render_states.RENDER_CANCELED;

	for (key in this._child_views) {
		this._child_views[key].cancelRender();
	}
	this._child_views = {};
};

/**
 * Builds a Renderer with all necessary data pulled from the view
 * 
 * @return {Renderer}
 */
Bifocals.prototype.buildRenderer = function bifocals_buildRenderer() {
	var _self = this;

	var renderer = new (exports.getRenderer(this.content_type))();
	renderer.data = this._data;
	renderer.response = this.response;
	renderer.error(function (error) {
		_self.render_state = render_states.RENDER_FAILED;
		_self._error(error);
	}).end(function () {
		_self.render_state = render_states.RENDER_COMPLETE;
	});
	return renderer;
};


/**
 * Sets an error handler which will be called any time an error occurs in this view
 * 
 * @param  {Function} fn takes a single parameter, the error
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.error = function bifocals_error(fn) {
	this._error = fn;
	return this;
};


/**
 * Create a child view relative to this view
 * 
 * @param {String} key required, the key the parent will render the data in
 * @param {String} template required, the template file to be rendered
 * @returns {Bifocals}
 */
Bifocals.prototype.child = function bifocals_child(key, template) {
	var new_view = new Bifocals();
	new_view.content_type = this.content_type;
	new_view.parent = this;
	new_view.root = this.root;
	new_view.dir = this.dir;
	new_view.error(this._error);
	
	if (template) {
		new_view.template = template;
	}

	// Makes a fake response that writes to the parent instead of to an actual response object
	new_view.response = {
		buffer: '',
		write: function (chunk) {
			this.buffer += chunk; 
		},
		end: function () { 
			// flag the child view as rendered
			new_view.render_state = render_states.RENDER_COMPLETE;

			// set the child data into the parent view, and then render the parent if possible
			new_view.parent.set(key, this.buffer); 

			if(new_view.parent.canRender()) {
				// Break up render flow by processing any parent renders on the next tick
				process.nextTick(function () {
					new_view.parent.render();
				});
			}
		}
	 };

	this._child_views[key] = new_view;

	return this._child_views[key];
};

/**
 * Set the response status code in the response tied to the parent most view
 * 
 * @param {int} code
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setStatusCode = function bifocals_setStatusCode(code) {
	this.root.response.statusCode = code;
	return this;
};

/**
 * Set a collection of headers in the response tied to the parent most view
 * 
 * @param {Object} headers 
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setHeaders = function bifocals_setHeaders(headers) {
	var key = null;
	for(key in headers) {
		this.root.response.setHeader(key, headers[key]);
	}
	return this;
};

/**
 * Return a 404: Not found code, and overwrite the existing template with the one provided
 * 
 * @param  {string} template information passed to the root rendererer to be immediately rendered
 */
Bifocals.prototype.statusNotFound = function bifocals_statusNotFound(template) {
	this.setStatusCode(404);
	this.root.cancelRender();
	
	if (typeof template !== "string") {
		this.root.cancelRender();
		this.root.response.end();
	} else {
		this.root.render(template, true);
	}
};

/**
 * Return a 500: Error code, and overwrite the existing template with the one provided
 * 
 * @param {Error} error the error object you wish to provide to the view
 * @param  {String} template information passed to the root renderer to be immediately rendered
 */
Bifocals.prototype.statusError = function bifocals_statusError(error, template) {
	this.setStatusCode(500);
	this.root.set('error', error);

	if (typeof template !== "string") {
		this.root.cancelRender();
		this.root.response.end();
	} else {
		this.root.render(template, true);
	}
};

/**
 * Return a 201: Created code, and redirect the user to the provided url
 * 
 * This should be used any time you create a resource per request of a user.
 * 
 * for example, if I call
 * 
 * PUT /users
 * name=aaron&email=aaron@dashron.com
 * 
 * which successfully creates user 1, aaron
 * the view at /users should end as view.created('/users/1');
 * 
 * @param  {string} redirect_url
 */
Bifocals.prototype.statusCreated = function bifocals_statusCreated(redirect_url) {
	this.setStatusCode(201);
	this.setHeaders({
		Location : redirect_url
	});
	this.root.cancelRender();
	this.root.response.end();
};

/**
 * Return a 302: Found code, 
 * 
 * @todo  add support for other 300's within this function
 * @todo describe how this would be properly used
 * @param  {string} redirect_url
 */
Bifocals.prototype.statusRedirect = function bifocals_statusRedirect(redirect_url) {
	this.setStatusCode(302);
	this.setHeaders({
		Location : redirect_url
	});
	this.root.cancelRender();
	this.root.response.end();
};

/**
 * Returns a 304: Not found code,
 * 
 * This tells the browser to use a previously cached version of this page.
 * @todo : as a parameter take some headers to control this? date, etag, expires, cache control
 */
Bifocals.prototype.statusNotModified = function bifocals_statusNotModified() {
	this.setStatusCode(304);
	this.root.cancelRender();
	// date
	// etag
	// expires
	// cache  control
	this.root.response.end();
};

/**
 * Returns a 405: Unsupported Method code,
 * 
 * This is used to state that the method (GET, POST, PUT, PATCH, DELETE, HEAD) is not supported for the
 * requested uri. You must provide a list of acceptable methods
 * 
 * @param  {Array} supported_methods 
 */
Bifocals.prototype.statusUnsupportedMethod = function bifocals_statusUnsupportedMethod(supported_methods) {
	this.setStatusCode(405);
	this.setHeaders({
		Allow : supported_methods.join(',')
	});
	this.root.cancelRender();
	this.root.response.end();
};

Bifocals.prototype.statusUnauthorized = function bifocals_statusUnauthorized(template)
{
	this.setStatusCode(401);
	this.root.cancelRender();
	if (typeof template !== "string") {
		this.root.cancelRender();
		this.root.response.end();
	} else {
		this.root.render(template, true);
	}
};

/**
 * Base object to handle rendering view data
 */
var Renderer = exports.Renderer = function Renderer() {
	this.response = {};
	this.data = {};
};

Renderer.prototype.response = null;
Renderer.prototype.data = null;

Renderer.prototype._error = function renderer_defaultError(err) {
	// In case the error is called before the error handler is applied, we mess with the function so we still get output
	this.error = function (fn) {
		process.nextTick(function () {
			fn(err);
		});
		return this;
	};
};
Renderer.prototype._end = function renderer_defaultEnd() {
	this.end = function (fn) {
		process.nextTick(fn);
		return this;
	};
};

/**
 * Assigns a function to be called any time an error occurs in the renderer
 * 
 * @param  {Function} fn takes a single parameter, the error
 * @return {Renderer} this, used for chaining
 */
Renderer.prototype.error = function renderer_error(fn) {
	this._error = fn;
	return this;
};

/**
 * Assigns a function to be called when the rendering ends
 * 
 * @return {Renderer} this, used for chaining
 */
Renderer.prototype.end = function renderer_end(fn) {
	this._end = fn;
	return this;
};