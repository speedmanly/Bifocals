"use strict";

var express = require('express');
var app = express();
var bifocals_module = require('../index');
var Bifocals = bifocals_module.Bifocals;

app.configure(function(){
	app.set('views', __dirname + '/templates');
	bifocals_module.addRenderer('text/html', require('consolidate').handlebars); 
});

app.use(bifocals_module.__express({
	app : app
}));

app.get('/', function (req, res) {
	var data = {
		'name' : 'Aaron Hedges',
		'date' : new Date()
	};

	var first_child = res.child('first_child');
	first_child.render('sub1');

	var second_child = res.child('second_child', 'sub2');
	second_child.render('sub1');

	var third_child = res.child('third_child');
	process.nextTick(function () {
		third_child.render('sub3');
	});

	res.render('index', data, function (err) {
		if (err) {
			throw err;
		} else {
			console.log('render complete');
		}
	});
});

app.listen(8125);
