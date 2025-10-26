import path from "tjs:path";
import { App, AppInfo, AppInfoFactory, AppState } from "../core/app";
import AppManager from "../core/manager";
import Router from "../http/router";
import { getError } from "../utils/error";
import { Message } from "../core/console";
import { writeTextFile } from "../utils/fs";

const APP_REQUIRED_DATA: Array<keyof AppInfoFactory> = ['name', 'version', 'description'];

export default function initAPI(route: Router, manager: AppManager){
    // 列举所有app
    route.get('/@api/list', async ctx => {
        ctx.json(manager.list().map(app => manager.getStatus(app.name)).filter(Boolean));
    });
    // 获取app状态
    route.get('/@api/stat/:name', async ctx => {
        const name = ctx.params['name'];
        if(!name) return ctx.json({ error: 'name is required' }, 400);

        // use SSE
        if(ctx.client.getHeaders('accept').some(v => v.includes('text/event-stream'))){
            const sse = await ctx.sse();
            if(!manager.get(name)) sse.close();
            const timer = setInterval(() => 
                sse.send(JSON.stringify(manager.getStatus(name))).catch(() => clearInterval(timer))
            , 1000);
        }else{
            const app = manager.getStatus(name);
            if(!app) return ctx.json({ error: 'app not found' }, 404);
            ctx.json(app);
        }
    })
    // 控制app
    route.post('/@api/control/:name', async ctx => {
        if(!ctx.params['name'])
            return ctx.json({ error: 'name is required' }, 400);
        const state = await ctx.body.text();
        const app = manager.get(ctx.params['name']);
        if(!app) return ctx.json({ error: 'app not found' }, 404);
        try{
            switch(state){
                case 'START':
                    await app.run();
                break;

                case 'STOP':
                    await app.stop();
                break;

                case 'RESTART':
                    await app.restart();
                break;

                case 'RELOAD':
                    await app.init(app.info!);
                break;

                default:
                    return ctx.json({ error: 'invalid state' }, 400);
            }
        }catch(e){
            return ctx.json({ error: getError(e), full: String(e) }, 500);
        }
    });
    // 创建app
    route.put('/@api/control/:name', async ctx => {
        const name = ctx.params['name'];
        if(!name) return ctx.json({ error: 'name is required' }, 400);

        const info: AppInfo = await ctx.body.json();
        const app = manager.get(name);

        // 检查
        for(const key of APP_REQUIRED_DATA){
            if(typeof info[key] != 'string')
                return ctx.json({ error: `${key} is required` }, 400);
        }
        if(typeof info.$code != 'string'){
            return ctx.json({ error: `file data is required` }, 400);
        }

        // 检查语法错误
        const data = new TextEncoder().encode(info.$code);
        try{
            tjs.engine.compile(data);
        }catch(e){
            return ctx.json({ error: `pre-compile error: ${getError(e)}` }, 400);
        }

        // 添加ts
        info.timestamp = Date.now();

        // 创建
        const distPath = path.join(App.app_base_dir, name + '.' + info.timestamp + '.js');
        await writeTextFile(distPath, info.$code);

        // 重载或创建
        delete info.$code;
        try{
            await manager.init(name, info);
        }catch(e){
            return ctx.json({ error: getError(e) }, 400);
        }
        return ctx.json({ success: true });
    })
    // 删除app
    route.delete('/@api/control/:name', async ctx => {
        const name = ctx.params['name'];
        if(!name) return ctx.json({ error: 'name is required' }, 400);
        try{
            await manager.unregister(name);
        }catch(e){
            return ctx.json({ error: `uninstall error: ${getError(e)}` }, 500);
        }
        return ctx.json({ success: true });
    });

    // log
    route.get('/@api/logs/:name', async ctx => {
        const name = ctx.params['name'];
        const app = manager.get(name);
        if(!app) return ctx.json({ error: 'app not found' }, 404);
        
        const sse = await ctx.sse();
        
        // get app log
        await sse.send(JSON.stringify(app.console.log), 'message', '0');
        const logHandler = (msg: Message) => sse.send(JSON.stringify(msg), 'message', msg.uuid).catch(
            e => { console.error(`ERR log sseSend(): ${getError(e)}`); end() }
        );
        const end = () => app.console.off('log', logHandler);
        app.console.on('log', logHandler);
    });
}