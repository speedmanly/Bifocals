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
 * Registers a render function to a content type
 * @param {string} content_type The content type (or mime type) of the request
 * @param {Renderer} renderer     The renderer object that will handle view data
 */
exports.addRenderer = function (content_type, renderer) {
	_renderers[content_type] = renderer;
};

/**
 * Returns a renderer for a content type
 * @param  {string} content_type The content type (or mime type) of the request
 * @return {Renderer}              The renderer associated with the content type
 * @throws {Error} If a renderer has not been added to the content_type
 */
exports.getRenderer = function (content_type) {
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
	RENDER_CANCELLED : 5
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
 * var template = new Bifocals("templates/index.html");
 * template.setResponse(response)
 * 
 * //Create the child:
 * var child = template.child("header", "templates/header.html");
 * child.title = "Hello World";
 * 
 * //Write the view to the response
 * template.render();
 * 
 * //And you are done! You don't have to tell the child views to render, that is all handled for you.
 * //The final rendered contents of Child will be rendered in template's "header" tag, so make sure you use raw data and don't escape it
 * //If you want to use the js or css functions, you need to 
 * 
 * @author Aaron Hedges <aaron@dashron.com>
 * @todo add timeouts
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

Bifocals.prototype._template = null;
Bifocals.prototype._response = null;
Bifocals.prototype._data = null;
Bifocals.prototype._child_views = null;
Bifocals.prototype._content_type = null;

Bifocals.prototype._error = function (error) {
	console.log(error);
	throw new Error('No error handler has been assigned to this view. Are one of your status calls erroring (404, 500, etc?). Maybe you have not set an error handler for your root template');
};

Bifocals.prototype.dir = null;
Bifocals.prototype.parent = null;
Bifocals.prototype.root = null;

/**
 * Assign the response object that will be written to with the final output
 * 
 * If a ServerResponse is provided, a default content type of text/plain will be set, along with 
 * a status code of 200.
 * 
 * @param {ServerResponse|Object} response
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setResponse = function view_setResponse(response) {
	if (response instanceof http_module.ServerResponse) {
		response.setHeader('Content-Type', 'text/plain');
		response.status_code = 200;
	}

	this._response = response;

	return this;
};

/**
 * Sets the content type of the output.
 * This is used in choosing a Renderer
 * 
 * @param {string} content_type
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setContentType = function view_setContentType(content_type) {
	this._content_type = content_type;
	return this;
};

/**
 * Tells the view which template to look for when rendering the final output
 * 
 * @type {string} template
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setTemplate = function view_setTemplate(template) {
	this._template = template;
	return this;
};

/**
 * returns whether the view has finished rendering or not
 * @returns {Boolean}
 */
Bifocals.prototype.isRendered = function view_isRendered() {
	return this.render_state === render_states.RENDER_COMPLETE;
};

/**
 * Sets data to be rendered to the view
 * @param {String} key
 * @param {mixed} value
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.set = function view_set(key, value) {
	this._data[key] = value;
	return this;
};

/**
 * Sets data to be rendered by the root template (eg page title)
 * @param {string} key 
 * @param {mixed} value
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setToRoot = function view_setToRoot(key, value) {
	this.root.set(key, value);
	return this;
};

/**
 * Retrieves all of the data so that it can be rendered by a parent
 * @param {String} key
 * @return {Mixed|Object}
 */
Bifocals.prototype.get = function view_get(key) {
	if(typeof key === "string") {
		return this._data[key];
	}
	return this._data;
};

/**
 * Executes the provided function, and adds all the keys in the returned object
 * to the data which will be rendered in this view
 * 
 * @TODO: This function should be saved, and only executed when render is called.
 * @param {Function} func
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.fill = function view_fill(func) {
	var new_data = func();
	var i = null;
	for(i in new_data) {
		this._data[i] = new_data[i];
	}
	return this;
};

/**
 * If the view is ready to be rendered, this will be true, otherwise false
 * @returns {Boolean}
 */
Bifocals.prototype.canRender = function view_canRender() {
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
 * @param {String} template Renders the provided template unless one was set previously.
 * @param {Boolean} force Kills all child elements and forces the template to be rendered immediately. default: false
 */
Bifocals.prototype.render = function view_render(template, force) {
	if (!force) {
		// If rendering has been cancelled before we try to render, do nothing
		if (this.render_state === render_states.RENDER_CANCELLED) {
			return;
		}

		this.render_state = render_states.RENDER_REQUESTED;

		if (this.canRender()) {
			this.render_state = render_states.RENDER_STARTED;
			// We want to prefer the pre-set template over the render(template)
			if (this._template) {
				template = this._template;
			}
			this.buildRenderer().render(this.dir + template);
		} else {
			// If a template has not yet been assigned to this view, and we can not immediately render it
			// we need to set the provided template, so it is rendered in the future
			if (!this._template) {
				this.setTemplate(template);
			}
		}
	} else {
		this.cancelRender();
		this.render_state = render_states.RENDER_REQUESTED;
		this.setTemplate(template);
		this.render(template, false);
	}
};

/**
 * Stops a render from occuring, and attempts to stop all child elements too.
 */
Bifocals.prototype.cancelRender = function () {
	var key = null;
	this.render_state = render_states.RENDER_CANCELLED;

	for (key in this._child_views) {
		this._child_views[key].cancelRender();
	}
	this._child_views = {};
};

/**
 * Builds a Renderer with all necessary data pulled from the view
 * @return {Renderer}
 */
Bifocals.prototype.buildRenderer = function view_buildRenderer() {
	var _self = this;

	var renderer = new (exports.getRenderer(this._content_type))();
	renderer.data = this._data;
	renderer.response = this._response;
	renderer.error(function (error) {
		_self.render_state = render_states.RENDER_FAILED;
		_self._error(error);
	});
	renderer.end(function() {
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
Bifocals.prototype.error = function view_error(fn) {
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
Bifocals.prototype.child = function view_child(key, template) {
	var new_view = new Bifocals();
	new_view.setContentType(this._content_type);
	new_view.parent = this;
	new_view.root = this.root;
	new_view.dir = this.dir;
	new_view.error(this._error);
	
	if (template) {
		new_view.setTemplate(template);
	}

	// Makes a fake response that writes to the parent instead of to an actual response object
	new_view.setResponse({
		buffer: '',
		write: function(chunk) {
			this.buffer += chunk; 
		},
		end: function() { 
			// flag the child view as rendered
			new_view.render_state = render_states.RENDER_COMPLETE;

			// set the child data into the parent view, and then render the parent if possible
			new_view.parent.set(key, this.buffer); 

			if(new_view.parent.canRender()) {
				process.nextTick(function() {
					new_view.parent.render();
				});
			}
		}
	 });

	this._child_views[key] = new_view;

	return this._child_views[key];
};

/**
 * Set the response status code in the response tied to the parent most view
 * 
 * @param {int} code
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setStatusCode = function view_setStatusCode(code) {
	this.root._response.statusCode = code;
	return this;
};

/**
 * Set a collection of headers in the response tied to the parent most view
 * 
 * @param {Object} headers 
 * @return {Bifocals} this, used for chaining
 */
Bifocals.prototype.setHeader = function view_setHeaders(headers) {
	var key = null;
	for(key in headers) {
		this.root._response.setHeader(key, headers[key]);
	}
	return this;
};

/**
 * Return a 404: Not found code, and overwrite the existing template with the one provided
 * 
 * @param  {string} template information passed to the root rendererer to be immediately rendered
 */
Bifocals.prototype.statusNotFound = function view_notFound(template) {
	this.root.cancelRender();
	this.root._response.statusCode = 404;
	this.root._response.end();
};

/**
 * Return a 500: Error code, and overwrite the existing template with the one provided
 * 
 * @param {Error} error the error object you wish to provide to the view
 * @param  {String} template information passed to the root renderer to be immediately rendered
 */
Bifocals.prototype.statusError = function view_error(error, template) {
	this.root.set('error', error);
	this.root._response.statusCode = 500;

	if (typeof template !== "string") {
		this.root.cancelRender();
		this.root._response.end();
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
Bifocals.prototype.statusCreated = function view_created(redirect_url) {
	this.root.cancelRender();
	this.root._response.statusCode = 201;
	this.root._response.setHeader('Location', redirect_url);
	this.root._response.end();
};

/**
 * Return a 302: Found code, 
 * 
 * @todo  add support for other 300's within this function
 * @todo describe how this would be properly used
 * @param  {string} redirect_url
 */
Bifocals.prototype.statusRedirect = function view_redirect(redirect_url) {
	this.root.cancelRender();
	this.root._response.statusCode = 302;
	this.root._response.setHeader('Location', redirect_url);
	this.root._response.end();
};

/**
 * Returns a 304: Not found code,
 * 
 * This tells the browser to use a previously cached version of this page.
 * @todo : as a parameter take some headers to control this? date, etag, expires, cache control
 */
Bifocals.prototype.statusNotModified = function view_notModified() {
	this.root.cancelRender();
	this.root._response.statusCode = 304;
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
Bifocals.prototype.statusUnsupportedMethod = function view_unsupportedMethod(supported_methods) {
	this.root.cancelRender();
	this.root._response.statusCode = 405;
	this.root._response.setHeader('Allow', supported_methods.join(','));
	this.root._response.end();
};

/**
 * Base object to handle rendering view data
 */
var Renderer = exports.Renderer = function() {
	this.response = {};
	this.data = {};
};

Renderer.prototype.response = null;
Renderer.prototype.data = null;
Renderer.prototype._error = function (err) {
	// In case the error is called before the error handler is applied, we mess with the function so we still get output
	this.error = function (fn) {
		fn(err);
	};
};
Renderer.prototype._end = function () {
	this.end = function (fn) {
		fn();
	};
};

/**
 * Assigns a function to be called any time an error occurs in the renderer
 * 
 * @param  {Function} fn takes a single parameter, the error
 * @return {Renderer} this, used for chaining
 */
Renderer.prototype.error = function (fn) {
	this._error = fn;
	return this;
};

/**
 * Assigns a function to be called when the rendering ends
 * 
 * @return {Renderer} this, used for chaining
 */
Renderer.prototype.end = function (fn) {
	this._end = fn;
	return this;
};
