/* Keeps the app on the device so it opens with no internet. */
var CACHE='cactus-stock-xl-v1';
var SHELL=['./','index.html','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
self.addEventListener('install',function(e){e.waitUntil(caches.open(CACHE).then(function(c){return Promise.all(SHELL.map(function(u){return c.add(u).catch(function(){})}))}).then(function(){return self.skipWaiting()}))});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(ks){return Promise.all(ks.filter(function(k){return k!==CACHE}).map(function(k){return caches.delete(k)}))}).then(function(){return self.clients.claim()}))});
self.addEventListener('fetch',function(e){
  var req=e.request;if(req.method!=='GET')return;
  e.respondWith((req.mode==='navigate'
    ?fetch(req).then(function(r){var cp=r.clone();caches.open(CACHE).then(function(c){c.put('index.html',cp)});return r}).catch(function(){return caches.match('index.html').then(function(m){return m||caches.match('./')})})
    :caches.match(req).then(function(m){return m||fetch(req).then(function(r){if(r&&(r.status===200||r.type==='opaque')){var cp=r.clone();caches.open(CACHE).then(function(c){c.put(req,cp)})}return r})})
  ).catch(function(){return new Response('',{status:504})}));
});
