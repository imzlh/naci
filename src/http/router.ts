import path from "tjs:path";
import HTTPClient, { HTTPRequest, HTTPHeaders } from "./client";
import AsyncPipe from "./pipe";
import { MIMEMAP, STATUS } from "./define";
import assert from "../utils/assert";
import { getError } from "../utils/error";

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' | 'TRACE' | 'CONNECT';

interface RouteParams {
    [key: string]: string;
}

interface Context {
    readonly req: HTTPRequest;
    readonly client: HTTPClient;
    readonly pipe: AsyncPipe;
    params: RouteParams;
    query: URLSearchParams;
    state: Record<string, any>;
    
    // 读取请求体
    body: {
        bytes(): Promise<Uint8Array>;
        text(): Promise<string>;
        json<T = any>(): Promise<T>;
    };

    // 发送响应
    send(data: string | Uint8Array, code?: number): Promise<void>;
    json(data: any, code?: number): Promise<void>;
    html(html: string, code?: number): Promise<void>;
    stream(status?: number, length?: number): Promise<WritableStream<Uint8Array>>;
    redirect(url: string, code?: number): Promise<void>;
    status(code: number, message?: string): Promise<void>;
    
    // 设置响应头
    header(name: string, value: string): void;
    
    // SSE
    sse(): Promise<SSEContext>;
    
    // WebSocket
    upgrade(): Promise<WSContext>;
}

interface SSEContext {
    send(data: string, event?: string, id?: string): Promise<void>;
    close(): void;
}

interface WSContext {
    receive(): Promise<string | Uint8Array | null>;
    send(data: string | Uint8Array): Promise<void>;
    close(code?: number, reason?: string): Promise<void>;
    ping(data?: Uint8Array): Promise<void>;
}

type Handler = (ctx: Context) => void | Promise<void>;
type ErrorHandler = (error: Error, ctx: Context) => void | Promise<void>;
type Middleware = (ctx: Context, next: () => Promise<void>) => void | Promise<void>;

interface RouteNode {
    handler?: Handler;
    children: Map<string, RouteNode>;
    paramchild?: { name: string; node: RouteNode };
    wildcardchild?: RouteNode;
}

interface MatchResult {
    handler: Handler;
    params: RouteParams;
}

/**
 * 轻量级 HTTP 路由器
 */
export default class Router {
    static CHUNK_SIZE = 16 * 1024;
    static getHeaders(headers?: Map<string, string>): HTTPHeaders {
        const res = headers ? Object.fromEntries(headers.entries()) : {};

        // Create Date header
        const date = new Date();
        res['Date'] = date.toUTCString();

        // Server:
        res['Server'] = '@imzlh/naci v1.0';

        return res;
    }

    private $routes = new Map<HTTPMethod, RouteNode>();
    private $middlewares: Middleware[] = [];
    private $errorhandler?: ErrorHandler;
    private $responseheaders = new Map<string, string>();

    constructor() {
        // 初始化所有 HTTP 方法的路由树
        const methods: HTTPMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
        for (const method of methods) {
            this.$routes.set(method, this.createnode());
        }
    }

    /**
     * 创建路由节点
     */
    private createnode(): RouteNode {
        return {
            children: new Map(),
            paramchild: undefined,
            wildcardchild: undefined,
            handler: undefined
        };
    }

    /**
     * 解析路径为段
     */
    private parsepath(path: string): string[] {
        return path.split('/').filter(s => s.length > 0);
    }

    /**
     * 注册路由
     */
    private addroute(method: HTTPMethod, path: string, handler: Handler): void {
        const root = this.$routes.get(method)!;
        const segments = this.parsepath(path);
        
        let node = root;
        for (const segment of segments) {
            if (segment.startsWith(':')) {
                // 参数路由
                const paramname = segment.slice(1);
                if (!node.paramchild) {
                    node.paramchild = { name: paramname, node: this.createnode() };
                }
                node = node.paramchild.node;
            } else if (segment === '*') {
                // 通配符路由
                if (!node.wildcardchild) {
                    node.wildcardchild = this.createnode();
                }
                node = node.wildcardchild;
                break; // 通配符必须是最后一个
            } else {
                // 静态路由
                if (!node.children.has(segment)) {
                    node.children.set(segment, this.createnode());
                }
                node = node.children.get(segment)!;
            }
        }
        
        node.handler = handler;
    }

    /**
     * 匹配路由
     */
    private matchroute(method: HTTPMethod, path: string): MatchResult | null {
        const root = this.$routes.get(method);
        if (!root) return null;
        
        const segments = this.parsepath(path);
        const params: RouteParams = {};
        
        const match = (node: RouteNode, index: number): Handler | null => {
            // 到达路径末尾
            if (index === segments.length) {
                return node.handler || null;
            }
            
            const segment = segments[index];
            
            // 1. 尝试静态匹配
            const staticchild = node.children.get(segment);
            if (staticchild) {
                const result = match(staticchild, index + 1);
                if (result) return result;
            }
            
            // 2. 尝试参数匹配
            if (node.paramchild) {
                params[node.paramchild.name] = segment;
                const result = match(node.paramchild.node, index + 1);
                if (result) return result;
                delete params[node.paramchild.name];
            }
            
            // 3. 尝试通配符匹配
            if (node.wildcardchild?.handler) {
                return node.wildcardchild.handler;
            }
            
            return null;
        };
        
        const handler = match(root, 0);
        return handler ? { handler, params } : null;
    }

    /**
     * 注册中间件
     */
    use(middleware: Middleware): this {
        this.$middlewares.push(middleware);
        return this;
    }

    /**
     * 注册错误处理器
     */
    onerror(handler: ErrorHandler): this {
        this.$errorhandler = handler;
        return this;
    }

    /**
     * 设置默认响应头
     */
    setheader(name: string, value: string): this {
        this.$responseheaders.set(name.toLowerCase(), value);
        return this;
    }

    /**
     * 注册 GET 路由
     */
    get(path: string, handler: Handler): this {
        this.addroute('GET', path, handler);
        return this;
    }

    /**
     * 注册 POST 路由
     */
    post(path: string, handler: Handler): this {
        this.addroute('POST', path, handler);
        return this;
    }

    /**
     * 注册 PUT 路由
     */
    put(path: string, handler: Handler): this {
        this.addroute('PUT', path, handler);
        return this;
    }

    /**
     * 注册 DELETE 路由
     */
    delete(path: string, handler: Handler): this {
        this.addroute('DELETE', path, handler);
        return this;
    }

    /**
     * 注册 PATCH 路由
     */
    patch(path: string, handler: Handler): this {
        this.addroute('PATCH', path, handler);
        return this;
    }

    /**
     * 注册 HEAD 路由
     */
    head(path: string, handler: Handler): this {
        this.addroute('HEAD', path, handler);
        return this;
    }

    /**
     * 注册 OPTIONS 路由
     */
    options(path: string, handler: Handler): this {
        this.addroute('OPTIONS', path, handler);
        return this;
    }

    /**
     * 注册所有方法的路由
     */
    all(path: string, handler: Handler): this {
        const methods: HTTPMethod[] = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];
        for (const method of methods) {
            this.addroute(method, path, handler);
        }
        return this;
    }

    /**
     * 创建上下文
     */
    private createcontext(client: HTTPClient, req: HTTPRequest): Context {
        const url = new URL(req.url, 'http://localhost');
        const responseheaders = new Map<string, string>(this.$responseheaders);
        let bodycached: Uint8Array | null = null;

        const ctx: Context = {
            req,
            client,
            pipe: client.pipe,
            params: {},
            query: url.searchParams,
            state: {},

            body: {
                async bytes() {
                    if (!bodycached) {
                        bodycached = await client.readFullBody();
                    }
                    return bodycached;
                },

                async text() {
                    const body = await this.bytes();
                    return new TextDecoder().decode(body);
                },

                async json<T = any>() {
                    const text = await this.text();
                    return JSON.parse(text) as T;
                },
            },

            async send(data: string | Uint8Array, code = 200) {
                await client.writeResponse(code, STATUS[code] ?? 'Reserved', Router.getHeaders(responseheaders), data);
            },

            async json(data: any, code = 200) {
                responseheaders.set('content-type', 'application/json');
                await this.send(JSON.stringify(data), code);
            },

            async html(html: string, code = 200) {
                responseheaders.set('content-type', 'text/html; charset=utf-8');
                await this.send(html, code);
            },

            async stream(code = 200, length = -1){
                if(length >= 0) responseheaders.set('content-length', length.toString());
                else responseheaders.set('transfer-encoding', 'chunked');
                await client.writeResponse(code, STATUS[code] ?? 'Reserved', Router.getHeaders(responseheaders));

                let writed = 0;
                return new WritableStream<Uint8Array>({
                    write(chunk) {
                        if(length >= 0){    // body
                            if(writed + chunk.byteLength > length)
                                throw new Error('Stream length exceeded');
                            writed += chunk.byteLength;
                            client.pipe.write(chunk);
                        }else{      // chunked
                            client.writeChunk(chunk);
                        }
                    },
                    close() {
                        if(length < 0){
                            client.endChunked();
                        }else{
                            if(writed < length) client.close();
                            // already done
                        }
                    }
                })
            },

            async redirect(url: string, code = 302) {
                responseheaders.set('location', url);
                await this.send('', code);
            },

            async status(code: number, message?: string) {
                await client.writeResponse(code, message ?? STATUS[code] ?? 'Reserved', Router.getHeaders(responseheaders));
            },

            header(name: string, value: string) {
                assert(!this.client.sent, "Cannot set header: response already sent");
                responseheaders.set(name.toLowerCase(), value);
            },

            async sse() {
                await client.sse();
                return {
                    async send(data: string, event?: string, id?: string) {
                        await client.sendSSEmessage(data, event, id);
                    },
                    close() {
                        client.close();
                    }
                };
            },

            async upgrade() {
                await client.ws();

                return {
                    async receive() {
                        const msg = await client.readWSmessage();
                        if (!msg) return null;
                        
                        if (msg.opcode === 0x1) { // TEXT
                            return new TextDecoder().decode(msg.data);
                        } else {
                            return msg.data;
                        }
                    },
                    async send(data: string | Uint8Array) {
                        await client.sendWSmessage(data);
                    },
                    async close(code?: number, reason?: string) {
                        await client.closews(code, reason);
                    },
                    async ping(data?: Uint8Array) {
                        await client.pingWS(data);
                    }
                };
            }
        };

        return ctx;
    }

    /**
     * 处理请求
     */
    async handle(client: HTTPClient): Promise<void> {
        try {
            // 启动 HTTP 解析
            await client.start();
            
            const req = client.request;
            if (!req) throw new Error("Invalid request");

            // 创建上下文
            const ctx = this.createcontext(client, req);

            // 匹配路由
            const url = new URL(req.url, 'http://localhost');
            const match = this.matchroute(req.method as HTTPMethod, url.pathname);

            if (!match) {
                await ctx.send('No Route Matched', 404);
                return;
            }

            // 设置路由参数
            ctx.params = match.params;

            // 执行中间件链
            let index = 0;
            const next = async (): Promise<void> => {
                if (index < this.$middlewares.length) {
                    const middleware = this.$middlewares[index++];
                    await middleware(ctx, next);
                } else {
                    // 执行路由处理器
                    await match.handler(ctx);
                }
            };

            await next();

        } catch (error) {
            // 错误处理
            if (this.$errorhandler && client.request) {
                try {
                    const ctx = this.createcontext(client, client.request);
                    await this.$errorhandler(error as Error, ctx);
                } catch (handlerError) {
                    console.error('Error handler failed:', handlerError);
                    try {
                        await client.writeResponse(500, 'Internal Server Error', Router.getHeaders(), 'Internal Server Error');
                    } catch {}
                }
            } else if(!(error instanceof Error && (error.message.includes('closed') || error.message.includes('reset')))) {
                console.error('Unhandled error:', getError(error));
                try {
                    await client.writeResponse(500, 'Internal Server Error', Router.getHeaders(), 'Internal Server Error');
                } catch {}
            }
        } finally {
            // 如果不是 keep-alive，关闭连接
            if (!client.keepalive) {
                client.close();
            }
        }
    }

    /**
     * 创建子路由器
     */
    route(prefix: string): Router {
        const subrouter = new Router();
        
        // 将子路由器的所有路由添加到当前路由器
        this.use(async (ctx, next) => {
            const url = new URL(ctx.req.url, 'http://localhost');
            if (url.pathname.startsWith(prefix)) {
                // 修改 URL 以匹配子路由
                const newpath = url.pathname.slice(prefix.length) || '/';
                const newreq = { ...ctx.req, url: newpath };
                const newctx = { ...ctx, req: newreq };
                
                await subrouter.handle(ctx.client);
            } else {
                await next();
            }
        });
        
        return subrouter;
    }

    /**
     * 静态文件服务
     */
    static(prefix: string, root: string, options?: {
        index?: string;
        dotfiles?: 'allow' | 'deny' | 'ignore';
        etag?: boolean;
        maxage?: number;
    }): this {
        const opts = {
            index: 'index.html',
            dotfiles: 'deny' as const,
            etag: true,
            maxage: 0,
            ...options
        };

        this.get(`${prefix}/*`, async (ctx) => {
            try {
                const url = new URL(ctx.req.url, 'http://localhost');
                let filepath = url.pathname.slice(prefix.length) || '/';
                
                // 移除查询参数和锚点
                filepath = filepath.split('?')[0].split('#')[0];
                
                // 防止路径穿越攻击
                if (filepath.includes('..')) {
                    await ctx.send('Forbidden', 403);
                    return;
                }
                
                // 拼接完整路径
                let fullpath = path.join(root, filepath);
                
                // 处理 dotfiles
                if (opts.dotfiles === 'deny' && filepath.split('/').some(s => s.startsWith('.'))) {
                    await ctx.send('Forbidden', 403);
                    return;
                }
                if (opts.dotfiles === 'ignore' && filepath.split('/').some(s => s.startsWith('.'))) {
                    await ctx.send('Not Found', 404);
                    return;
                }
                
                // 检查文件状态
                let stats: any;
                try {
                    stats = await tjs.stat(fullpath);
                } catch {
                    await ctx.send('Not Found', 404);
                    return;
                }
                
                // 如果是目录，尝试返回 index 文件
                if (stats.isDirectory) {
                    if (!filepath.endsWith('/')) {
                        await ctx.redirect(url.pathname + '/');
                        return;
                    }
                    fullpath = fullpath + opts.index;
                    try {
                        stats = await tjs.stat(fullpath);
                        if (!stats.isFile) {
                            await ctx.send('Forbidden', 403);
                            return;
                        }
                    } catch {
                        await ctx.send('Not Found', 404);
                        return;
                    }
                }
                
                // 检查 If-None-Match (ETag)
                if (opts.etag) {
                    const etag = `"${stats.size}-${stats.mtim.getTime()}"`;
                    const inm = ctx.req.headers['if-none-match'];
                    if (inm === etag) {
                        await ctx.status(304);
                        return;
                    }
                    ctx.header('etag', etag);
                }
                
                // 检查 If-Modified-Since
                const ims = ctx.req.headers['if-modified-since'];
                if (ims) {
                    const imsdate = new Date(ims as string);
                    if (stats.mtim <= imsdate) {
                        await ctx.status(304);
                        return;
                    }
                }
                
                // 设置响应头
                const mimetype = this.getmimetype(fullpath);
                ctx.header('content-type', mimetype);
                ctx.header('last-modified', stats.mtim.toUTCString());
                ctx.header('content-length', stats.size.toString());
                
                if (opts.maxage > 0) {
                    ctx.header('cache-control', `public, max-age=${opts.maxage}`);
                }
                
                // 处理 Range 请求
                const range = ctx.req.headers['range'] as string;
                if (range && range.startsWith('bytes=')) {
                    await this.sendrange(ctx, fullpath, stats.size, range);
                    return;
                }
                
                // 读取并发送文件
                const file = await tjs.open(fullpath, 'r');
                // write response headers
                const stream = await ctx.stream(200, stats.size);
                await file.readable.pipeTo(stream);
            } catch (error) {
                console.error('Static file error:', error);
                await ctx.send('Internal Server Error', 500);
            }
        });
        
        return this;
    }

    /**
     * 发送 Range 响应
     */
    private async sendrange(ctx: Context, filepath: string, filesize: number, range: string): Promise<void> {
        // 解析 Range 头
        const rangestr = range.slice(6); // 移除 'bytes='
        const parts = rangestr.split('-');
        
        let start = parseInt(parts[0]) || 0;
        let end = parts[1] ? parseInt(parts[1]) : filesize - 1;
        
        // 验证范围
        if (start < 0 || end >= filesize || start > end) {
            ctx.header('content-range', `bytes */${filesize}`);
            await ctx.send('Range Not Satisfiable', 416);
            return;
        }
        
        const size = end - start + 1;
        
        // 设置响应头
        ctx.header('content-range', `bytes ${start}-${end}/${filesize}`);
        ctx.header('content-length', size.toString());
        ctx.header('accept-ranges', 'bytes');
        
        // 读取文件片段
        const file = await tjs.open(filepath, 'r');
        const stream = await ctx.stream(206, size);
        const writer = stream.getWriter();
        let position = start;
        while (position <= end) {
            const chunksize = Math.min(Router.CHUNK_SIZE, end - position + 1);
            const chunk = new Uint8Array(chunksize);
            const r = await file.read(chunk, position);
            if (r === null) {
                await writer.close();
                throw new Error('Unexpected end of file');
            }
            await writer.write(chunk.slice(0, r));
            position += r;
        }
    }

    /**
     * 获取 MIME 类型
     */
    private getmimetype($path: string): string {
        const ext = path.extname($path).substring(1);   // remove dot
        return MIMEMAP[ext] ?? 'application/octet-stream';
    }
}

export { Router, Context, Handler, Middleware, ErrorHandler, SSEContext, WSContext, RouteParams };