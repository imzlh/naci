/**
 * Simple Task Manager
 * @version 1.0.0
 */

import path from "tjs:path";
import AppManager from "./src/core/manager";
import Router from "./src/http/router";
import Server from "./src/http/server";
import initAPI from "./src/route/api";
import HandlerClass from "./src/route/handler";
import initStatic from "./src/route/static";
import { ensure, writeTextFile } from "./src/utils/fs";

// 0. load context
const manager = new AppManager();

// 1. load app list
const APP_LIST = tjs.cwd + '/data/app.json';
async function loadAppList(){
    const text = new TextDecoder().decode(await tjs.readFile(APP_LIST));
    let json = [];
    try{
        json = JSON.parse(text);
        if(!Array.isArray(json))
            throw new Error('not an array');
    }catch(e){
        console.error('failed to parse app.json, will use empty list:', e);
    }
    manager.load(json);
    console.log('app list loaded:', json.length);
}
let pauseWatch = false;
async function saveAppList() {
    const json = manager.export();
    const text = JSON.stringify(json, null, 2);
    await writeTextFile(APP_LIST, text);
    pauseWatch = true;  // prevent infinite loop
}
await ensure(APP_LIST);
await loadAppList();
const watcher = tjs.watch(APP_LIST, () => {
    if(!pauseWatch) console.log('Change detected, reloading app list...'), loadAppList()
    pauseWatch = false;
});

// 2. init router
const router = new Router();
initAPI(router, manager);
initStatic(router, path.join(tjs.cwd, 'public'));
HandlerClass.router = router;

// 3. start server
const PORT = 8080;
const HOST = '0.0.0.0';
const server = await Server.create(HOST, PORT, HandlerClass);
server.run();

// 4. wait signal
let stopping = false;
tjs.addSignalListener('SIGINT', async function(){
    if(stopping) return console.log('already stopping...');
    stopping = true, pauseWatch = true;
    console.log('SIGINT received, stopping server in 3s...\n');
    await Promise.any([
        Promise.all([saveAppList(), server.stop()]),
        new Promise(resolve => setTimeout(resolve, 3000))
    ]).catch(e => console.error(e));
    watcher.close();
    tjs.exit(0);
})
globalThis.addEventListener('unhandledrejection', e => e.preventDefault());
globalThis.addEventListener('error', e => e.preventDefault());