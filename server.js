#!/bin/env node

/*jslint node: true, white: true, vars: true */
"use strict";


/* Required libraries*/

// Promises/A+ via when
var when    = require('when');

// Cookie handling
var node_cookies = require('cookies');



/* Check-in Fox Hosted version via OpenShift */
var CheckinFoxHosted = function() {

    //  Scope.
    var self = this;

    // Libs
    var url = require('url');
    var querystring = require('querystring');



    /* Set up server IP address and port # using env variables/defaults. */
    var http  = require('http');

    self.init = function() {
        // Production mode?
        self.LIVE = process.env.OPENSHIFT_APP_DNS ?true :false;
        self.HOST_LOCAL= "localhost:8080";
        self.HOST_LIVE = self.LIVE ?process.env.OPENSHIFT_APP_DNS :self.HOST_LOCAL;

        // Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP || process.env.OPENSHIFT_INTERNAL_IP || 'localhost';
        self.port      = process.env.OPENSHIFT_NODEJS_PORT ||  process.env.OPENSHIFT_INTERNAL_PORT || 8080; 

        // Init logging
        console.log("Init of <server.js> on ["+self.ipaddress+":"+self.port+"] started...");

        // Initialize termination handlers on exit and signals
        process.on('exit', function() {
            console.log('%s: Shutting down L8R ...', Date(Date.now()));
            self.terminate();
        });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
         'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() { self.terminate(element); });
        });

        // Init server
        self.server = http
            .createServer(function(req,res){
                process.nextTick(function(){ self.handleRequest(req,res); });
            })
            .listen(self.port, self.ipaddress, function() {
                console.log('%s: Node server started on %s:%d ...', Date(Date.now()), self.ipaddress, self.port);
            });

    };

    self.terminate = function(sig){
        if (typeof sig === "string") {
            console.log('%s: Received %s - terminating L8R ...', Date(Date.now()), sig);
            process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()) );
    };



    /* Process and decode incoming request */
    self.processRequest = function processRequest(req,res) {
        console.log("Processing request...");

        var def = null
            ,request_url = null,request_data = ""
            ,request = {
                'method': req.method
                ,'headers': req.headers
                ,'path': {}
                ,'data': {}
            };

        /* Prepare path */
        request_url=url.parse(req.url);
        var urlpath=request_url.pathname;
        request.path=(urlpath[0]==="/" ? urlpath.substr(1) : urlpath).split('/');

        /* Prepare POST/GET data vars */
        def = when.defer();
        if (req.method==="POST") {
            req.on("data",function(chunk) {
                request_data+=chunk;
            });
            req.on("end",function() {
                request.data=querystring.parse(request_data);
                def.resolve(request);
            });

        /* GET request inbound */
        } else {
            request.data = querystring.parse(request_url.query);

            def.resolve(request);
        }

        /* Prepare cookies */
        request.cookies=new node_cookies(req,res);

        /* Return a Promise with parsed request data */
        return def.promise;
    };


    /* Serve request */
    self.serveRequest = function(request) {
        console.log ("Serving %s request to %s (data in %d vars)", request.method, request.path.join('/'), Object.keys(request.data).length);
        var def = when.defer();


        /* Main servlet */
        var request_handler=require("./serve.js");
        request_handler(def.resolver,self,request);

        // Return promise
        return def.promise;
    };



    /* Handle all incoming requests */
    self.handleRequest = function(req, res) {
        try {

            self.processRequest(req,res)
            .then(self.serveRequest)
            .then(

                /* Success */
                function(response) {
                    console.log("served: %s",response);

                    // Cookies

                    if (response.cookies) {
                        var Cookies=new node_cookies(req, res);
                        var cookieOps=response.cookies;

                        // Loop through cookie operations, delete on falsy value
                        var C;
                        for (C in cookieOps) if (cookieOps.hasOwnProperty(C)) {
                            // Remove or update cookie
                            if (cookieOps[C]===null) Cookies.set(C); else Cookies.set(C,cookieOps[C]);
                        }
                    }

                    // Head
                    res.writeHead(
                        response.http_code
                        ,typeof response.http_string==="string" ? response.http_string : response.headers
                        ,typeof response.http_string==="string" ? response.headers : null
                    );

                    // Response body
                    res.end(response.response);
                }

                /* Server Error in response */
                ,function(err) {
                    console.log("%s Server Error in <handleRequest>: %s", Date(Date.now()), err);

                    var ret="Server Error: "+err;
                    res.writeHead(500,ret,{'Content-Type': 'text/plain; charset=utf-8','Content-Length': Buffer.byteLength(ret)});
                    res.end(ret);
                }
            );
        }

        catch (e) {
            console.log("%s An Exception occured in <handleRequest>: %s", Date(Date.now()), e);
        }
    };

}; /* end of: l8r */



/* MAIN */
var app = new CheckinFoxHosted();

app.init();
