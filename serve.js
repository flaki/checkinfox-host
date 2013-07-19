/*jslint node: true, white: true, vars: true, newcap: true */
'use strict';
console.log('<serve.js include>');

var when    = require('when');

var fs           = require('fs')
	,querystring = require('querystring')
	,https       = require('https')
	,util        = require('util');


function getFoursquareCredentials() {
	return JSON.parse(fs.readFileSync('./APP_CREDENTIALS.json',{encoding:'utf8'}));
}

function createEncryptedPayload(contents,key) {

	// Serialize contents to string if needed
	if (typeof contents!=="string") contents=JSON.stringify(contents);

	// Add prefix && timestamp
	contents="CHECKINFOX|"+contents+"|"+Date.now();

	// Encrypt
	var cipher = require('crypto').createCipher('aes128', key);
	var payload = cipher.update(contents, 'utf8', 'hex') + cipher.final('hex');

	return payload;
}

function decryptPayload(payload,key) {

	// Decrypt
	var decipher = require('crypto').createDecipher('aes128', key);
	var decrypted = decipher.update(payload, 'hex', 'utf8') + decipher.final('utf8');

	// Split to prefix|payload|timestamp
	var cryptObject=decrypted.split('|');

	// Invalid key
	if (!cryptObject) return null;

	// Invalid prefix
	if (cryptObject[0]!=='CHECKINFOX') return null;

	// More than five minutes have passed
	if (!cryptObject[2] || (Date.now()-cryptObject[2])/1000>400) return null;

	return cryptObject[1];
}

var MIMETable={
	txt:		'text/plain; charset=utf-8'
	,html:		'text/html; charset=utf-8'
	,js:		'text/javascript'
	,css:		'text/css'

	,png:		'image/png'
	,jpg:		'image/jpg'
	,gif:		'image/gif'

	,webapp:	'application/x-web-app-manifest+json'
	,appcache:	'text/cache-manifest'

	,zip:		'application/zip'
};
function guessContentType(filename) {
	var ext=filename.split('.').pop();

	if (MIMETable[ext]) return MIMETable[ext]; else return null;
}

// Read a file from the app directory
function readAppFile(path) {
	var i,l;
	var deferred=when.defer();

	// Build filepath
	var filepath=path.join("/")
		,filename=path[path.length-1];


	// Default file: index.html
	if (!filename) {
		filename=filepath='index.html';
	}

	// Get file mime type
	var mime=guessContentType(filename);
	if (!mime) deferred.reject('Unknown MIME type for `'+filename+'`!');

	// Read file
	fs.readFile('./app/'+filepath,function(err,data) {
		// Failed
		if (err) {
			console.error("App file not found: ",filepath);
			return deferred.reject(err);
		}

		deferred.resolve({mimetype:mime,contents:data});
	});

	return deferred.promise;
}







/* Auth expects a resolver, which it resolves based on successful whether it could successfully authenticate */
var request_handler=function (resolver, app, request) {
	var i,l;


	// Serve authenticator
	if ( request.path.length===1 && (request.path[0]==='auth') ) {
		console.log('Serving: Authenticator');

		// Redirect URI (authenticator url)
		var redirectURI='https://checkinfox-flaki.rhcloud.com/auth';

		// From client
		var requestKey=request.data.token;
		var requestClientID=request.data.client_id;

		// From api redirect
		var requestCode=request.data.code;

		// Foursquare app platform credentials
		var APICredentials=getFoursquareCredentials();


		/* Auth flow */
		if (requestClientID && !requestKey) {
		console.log('Serving: Authenticator/initial');

			// Make auth cookie
			var authCookie=createEncryptedPayload(requestClientID,APICredentials.client_secret);

			// Authentication type: (authenticate|authorize) (latter results in user feedback request every time)
			var authType='authorize';

			// Generate redirect url. Make sure user is presented the "touch" version from both login and auth dialogs
			var redirectUrl='https://foursquare.com/touch/login?'+querystring.stringify({
				'continue': '/oauth2/'+authType+'?'+querystring.stringify({
					 client_id: APICredentials.client_id
					,response_type: 'code'
					,redirect_uri: redirectURI
					,display: 'touch'
				})
			});

			// Generate redirect response
			return resolver.resolve({
				'http_code': 303
				,'headers': {
					 'Content-Type': 'text/plain; charset=utf-8'
					,'Location': redirectUrl
					,'Content-Length': Buffer.byteLength(redirectUrl)
				}
				,'cookies': { 'checkinfox_auth': authCookie }
				,'response': redirectUrl
			});


		/* Code response flow */
		} else if (requestCode) {
			console.log('Serving: Authenticator/code-response');

			// Request auth token
			var token_request=when.defer();

			// Token request url
			var tokenRequestURL='https://foursquare.com/oauth2/access_token?'+querystring.stringify({
				 client_id: APICredentials.client_id
				,client_secret: APICredentials.client_secret
				,grant_type: 'authorization_code'
				,redirect_uri: redirectURI
				,code: requestCode
			});

			// Make request
			https.get(tokenRequestURL, function(res) {
				var responseBody="";

				// Read
				res.on('readable', function() {
					responseBody+=res.read();
				});

				res.on('end', function() {

					// API error
					if (res.statusCode!==200) {
						console.error("API error: ",res.statusCode+" "+responseBody);
						token_request.resolver.reject(new Error(res.statusCode+" "+JSON.parse(responseBody)));

					// Success
					} else {
						token_request.resolver.resolve(responseBody);
					}
				});

			}).on('error', function(e) {
				console.error("Token request failed: "+e);
				token_request.resolver.reject(e);
			});


			// On successful token request save encrypted auth token and notify client
			var token_store=when(token_request.promise ,function(token) {
				// Load client app id from encrypted cookie
				requestClientID=decryptPayload(request.cookies.get('checkinfox_auth'),APICredentials.client_secret);

				// Invalid client id from auth cookie
				if (!requestClientID) {
					console.error("Invalid auth cookie.");
					resolver.reject(new Error("Invalid request!"));
				}

				// Generate keystring
				var keyString=Array.apply(0, Array(16)).map(function() {
					return (function(charset){
						return charset.charAt(Math.floor(Math.random() * charset.length));
					}('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789$!-_'));
				}).join('');

				// Generate encrypted payload
				var encryptedToken=createEncryptedPayload(token,requestClientID);

				// LocalStorage to store token until requested by client
				var LocalStorage = require('node-localstorage').LocalStorage;
				var localStorage = new LocalStorage('./tmp');

				localStorage.setItem(keyString,encryptedToken);

				// Load response content
				var ret=fs.readFileSync('./static/auth_response.html',{encoding:'utf8'});

				// Add keystring to response
				ret=ret.replace('%KEYSTRING%',keyString);


				// Display response
				return resolver.resolve({
					'http_code': 200
					,'headers': {
						 'Content-Type': MIMETable.html
						,'Content-Length': Buffer.isBuffer(ret) ?ret.length :Buffer.byteLength(ret)
					}
					,'cookies': { 'checkinfox_auth': null }
					,'response': ret
				});

			}

			// Token request failed
			,function (err) {
				resolver.reject(err); 
			});

			return;


		/* Token flow */
		} else if (requestClientID && requestKey) {
			console.log('Serving: Authenticator/access-token');

			// Read back encrypted auth token from storage
			var LocalStorage = require('node-localstorage').LocalStorage;
			var localStorage = new LocalStorage('./tmp');

			var encryptedToken=localStorage.getItem(requestKey);

			// Remove item after first access
			localStorage.removeItem(requestKey);

			// Decrypt client access token
			var accessToken=decryptPayload(encryptedToken,requestClientID);

			// Invalid token
			if (!requestClientID) {
				console.error("Getting auth token failed!");
				resolver.reject(new Error("Invalid request."));
			}

			// Generate redirect response
			return resolver.resolve({
				'http_code': 200
				,'headers': {
					 'Content-Type': MIMETable.txt
					,'Content-Length': Buffer.byteLength(accessToken)
					,'Access-Control-Allow-Origin': '*'
				}
				,'response': accessToken
			});


		/* Unknown flow */
		} else {
			resolver.reject(new Error('Illegal auth signature!'));

		}



	// Serve app contents
	} else {
		console.log('Serving: Hosted app');

		// Unread articles in db
		return when( readAppFile(request.path)

			// Valid app resource
			,function(file) {
				return resolver.resolve({
					'http_code': 200
					,'headers': {
						 'Content-Type': file.mimetype
						,'Content-Length': Buffer.isBuffer(file.contents) ?file.contents.length :Buffer.byteLength(file.contents)
					}
					,'response': file.contents
				});

		// If/when succeeded in generating page, resolve the passed resolver
		}).then(resolver.resolve, function (err) {
			// Not found
			if (err.code==="ENOENT") {
				var ret="<!DOCTYPE html><html><head><title>404 Not Found</title></head><body><h1>The requested URL is not found!</h1></body></html>";

				return resolver.resolve({
					'http_code': 404
					,'headers': {
						 'Content-Type': MIMETable.html
						,'Content-Length': ret.length
					}
					,'response': ret
				});

			// Other error
			} else {
				return resolver.reject( err.message||err );

			}
		});

	}

};


/* Return module export */
module.exports = request_handler;