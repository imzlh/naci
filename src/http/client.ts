import { createHash } from "tjs:hashing";
import AsyncPipe from "./pipe";
import assert from "../utils/assert";
import { EventBase } from "../core/event";

enum ReadState {
    IDLE,
    STATUS_LINE,
    HEADERS,
    BODY,
    TRAILER,
    DONE,
    ERROR,
    UPGRADED
}

enum Protocol {
    HTTP,
    WEBSOCKET,
    SSE
}

interface HTTPHeaders {
    [key: string]: string | string[];
}

interface RequestLine {
    method: string;
    url: string;
    version: string;
}

interface StatusLine {
    version: string;
    code: number;
    message: string;
}

interface HTTPMessage {
    headers: HTTPHeaders;
    version: string;
}

interface HTTPRequest extends HTTPMessage {
    method: string;
    url: string;
}

interface HTTPResponse extends HTTPMessage {
    code: number;
    message: string;
}

interface SSEMessage {
    event?: string;
    data: string;
    id?: string;
    retry?: number;
}

enum WSOpcode {
    CONTINUATION = 0x0,
    TEXT = 0x1,
    BINARY = 0x2,
    CLOSE = 0x8,
    PING = 0x9,
    PONG = 0xA
}

interface WSFrame {
    fin: boolean;
    opcode: WSOpcode;
    masked: boolean;
    payload: Uint8Array;
}

interface WSMessage {
    opcode: WSOpcode;
    data: Uint8Array;
}

/**
 * HTTP/1.1 客户端，支持 WebSocket 和 SSE
 */
export default class HTTPClient extends EventBase<{
    parse: void;
    upgrade: void;
    readDone: void;
    start: void;
    error: Error;
    write: void;
    response: HTTPResponse;
    request: HTTPRequest;
}> {
    static readonly ROLE_SERVER = 0;
    static readonly ROLE_CLIENT = 1;

    protected $pipe: AsyncPipe;
    private $role: number;
    private $state: ReadState = ReadState.IDLE;
    private $sent = false;
    private $protocol: Protocol = Protocol.HTTP;
    
    private $headers = new Map<string, string[]>();
    private $statusline?: StatusLine;
    private $requestline?: RequestLine;
    
    private $bodyremaining = 0;
    private $chunked = false;
    private $expecttrailer = false;
    private $keepalive = true;
    
    // WebSocket 状态
    private $wsfragments: Uint8Array[] = [];
    private $wsfragmentopcode?: WSOpcode;
    private $wsclosed = false;
    
    // SSE 状态
    private $ssebuffer = "";
    
    private $endedresolver?: (value: void) => void;
    private $endedrejecter?: (reason: any) => void;
    public readonly ended: Promise<void>;

    constructor(pipe: AsyncPipe, role: number = HTTPClient.ROLE_SERVER) {
        super();
        this.$pipe = pipe;
        this.$role = role;
        this.ended = new Promise((resolve, reject) => {
            this.$endedresolver = resolve;
            this.$endedrejecter = reject;
        });
    }

    reuse(){
        assert(this.$sent, "Cannot reuse a client that has not sent a request");
        assert(this.$state === ReadState.DONE, `Cannot reuse a client that has not finished reading the response (cur=${ReadState[this.$state]})`);
        this.$sent = false;
        this.$state = ReadState.IDLE;
    }

    /**
     * 解析状态行（客户端接收响应）
     */
    private async parseStatusLine(): Promise<void> {
        const line = await this.$pipe.readline(8192);
        if (!line) throw new Error("Connection closed before status line");

        const match = line.match(/^HTTP\/(\d+\.\d+)\s+(\d{3})\s*(.*)$/);
        if (!match) throw new Error(`Invalid status line: ${line}`);

        this.$statusline = {
            version: match[1],
            code: parseInt(match[2]),
            message: match[3]
        };
        
        this.$state = ReadState.HEADERS;
        this.emit('parse');
    }

    /**
     * 解析请求行（服务器接收请求）
     */
    private async parseRequestLine(): Promise<void> {
        const line = await this.$pipe.readline(8192);
        assert(line, "Connection closed before request line");

        const match = line.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/(\d+\.\d+)$/);
        assert(match, `Invalid request line: ${line}`);

        this.$requestline = {
            method: match[1],
            url: match[2],
            version: match[3]
        };
        
        this.$state = ReadState.HEADERS;
        this.emit('parse');
    }

    /**
     * 解析头部
     */
    private async parseHeaders(): Promise<void> {
        this.$headers.clear();
        
        while (true) {
            const line = await this.$pipe.readline(8192);
            if (!line) break; // 空行表示头部结束
            
            const colonIndex = line.indexOf(':');
            assert(colonIndex !== -1, `Invalid header line: ${line}`)

            const key = line.substring(0, colonIndex).trim().toLowerCase();
            const value = line.substring(colonIndex + 1).trim();

            const existing = this.$headers.get(key);
            if (existing) {
                existing.push(value);
            } else {
                this.$headers.set(key, [value]);
            }
        }

        this.analyzeheaders();
        this.$state = ReadState.BODY;
        this.emit('parse');
    }

    /**
     * 分析头部，确定消息体读取方式和协议升级
     */
    private analyzeheaders(): void {
        const transferEncoding = this.getHeader('transfer-encoding');
        const contentLength = this.getHeader('content-length');
        const connection = this.getHeader('connection')?.toLowerCase();
        const upgrade = this.getHeader('upgrade')?.toLowerCase();
        
        // 检查协议升级
        if (connection?.includes('upgrade') && upgrade) {
            if (upgrade === 'websocket') {
                this.$protocol = Protocol.WEBSOCKET;
                this.$state = ReadState.UPGRADED;
                this.emit('upgrade');
                return;
            }
        }
        
        // 检查 SSE
        const contentType = this.getHeader('content-type')?.toLowerCase();
        if (contentType === 'text/event-stream') {
            this.$protocol = Protocol.SSE;
        }
        
        // 检查是否使用分块编码
        if (transferEncoding) {
            const encodings = transferEncoding.toLowerCase().split(',').map(e => e.trim());
            this.$chunked = encodings.includes('chunked');
            this.$expecttrailer = this.$headers.has('trailer');
        }
        
        // 检查 Content-Length
        if (!this.$chunked && contentLength) {
            this.$bodyremaining = parseInt(contentLength);
            if (isNaN(this.$bodyremaining) || this.$bodyremaining < 0) {
                throw new Error(`Invalid Content-Length: ${contentLength}`);
            }
        }
        
        // 检查连接保持
        const version = this.$role === HTTPClient.ROLE_CLIENT 
            ? this.$statusline?.version 
            : this.$requestline?.version;
            
        if (version === '1.0') {
            this.$keepalive = connection === 'keep-alive';
        } else {
            this.$keepalive = connection !== 'close';
        }
    }

    /**
     * 获取单个头部值（大小写不敏感）
     */
    getHeader(name: string): string | undefined {
        const values = this.$headers.get(name.toLowerCase());
        return values ? values[0] : undefined;
    }

    /**
     * 获取所有头部值（大小写不敏感）
     */
    getHeaders(name: string): string[] {
        return this.$headers.get(name.toLowerCase()) || [];
    }

    /**
     * 设置头部（大小写不敏感）
     */
    setHeader(name: string, value: string | string[]): void {
        const values = Array.isArray(value) ? value : [value];
        this.$headers.set(name.toLowerCase(), values);
    }

    /**
     * 读取固定长度的消息体
     */
    private async readFixedBody(): Promise<Uint8Array | null> {
        if (this.$bodyremaining <= 0) {
            this.$state = ReadState.DONE;
            this.emit('readDone');
            return null;
        }

        const chunk = await this.$pipe.read(Math.min(this.$bodyremaining, 65536));
        if (!chunk) {
            throw new Error("Unexpected EOF while reading body");
        }

        this.$bodyremaining -= chunk.length;
        if (this.$bodyremaining === 0) {
            this.$state = ReadState.DONE;
            this.emit('readDone');
        }
        
        return chunk;
    }

    /**
     * 读取一个分块
     */
    private async readChunk(): Promise<Uint8Array | null> {
        // 读取分块大小行
        const sizeLine = await this.$pipe.readline(1024);
        if (!sizeLine) throw new Error("Unexpected EOF reading chunk size");

        // 解析分块大小（可能包含扩展）
        const sizeMatch = sizeLine.match(/^([0-9a-fA-F]+)/);
        if (!sizeMatch) throw new Error(`Invalid chunk size: ${sizeLine}`);

        const chunkSize = parseInt(sizeMatch[1], 16);
        
        // 分块大小为 0 表示结束
        if (chunkSize === 0) {
            this.$state = this.$expecttrailer ? ReadState.TRAILER : ReadState.DONE;
            this.emit(this.$expecttrailer ? 'parse' : 'readDone');
            return null;
        }

        // 读取分块数据
        const chunk = await this.$pipe.read(chunkSize);
        if (!chunk || chunk.length !== chunkSize) {
            throw new Error("Unexpected EOF reading chunk data");
        }

        // 读取分块后的 CRLF
        const trailing = await this.$pipe.readline(2);
        if (trailing !== "") {
            throw new Error("Missing CRLF after chunk data");
        }

        return chunk;
    }

    /**
     * 读取尾部头部（trailer）
     */
    private async readTrailer(): Promise<void> {
        while (true) {
            const line = await this.$pipe.readline(8192);
            if (!line) break;
            
            const colonIndex = line.indexOf(':');
            if (colonIndex === -1) continue;

            const key = line.substring(0, colonIndex).trim().toLowerCase();
            const value = line.substring(colonIndex + 1).trim();
            
            const existing = this.$headers.get(key);
            if (existing) {
                existing.push(value);
            } else {
                this.$headers.set(key, [value]);
            }
        }
        
        this.$state = ReadState.DONE;
        this.emit('readDone');
    }

    /**
     * 启动解析（读取状态行和头部）
     */
    async start(): Promise<void> {
        try {
            this.$state = this.$role === HTTPClient.ROLE_CLIENT 
                ? ReadState.STATUS_LINE 
                : ReadState.STATUS_LINE;
            this.emit('start');

            if (this.$role === HTTPClient.ROLE_CLIENT) {
                await this.parseStatusLine();
            } else {
                await this.parseRequestLine();
            }

            await this.parseHeaders();
        } catch (error) {
            this.$state = ReadState.ERROR;
            this.emit('error', error as Error);
            this.$endedrejecter?.(error);
            throw error;
        }
    }

    /**
     * 读取消息体数据
     */
    async readBody(): Promise<Uint8Array | null> {
        if (this.$state === ReadState.DONE) return null;
        if (this.$state !== ReadState.BODY && this.$state !== ReadState.TRAILER) {
            throw new Error("Not ready to read body");
        }

        try {
            if (this.$state === ReadState.TRAILER) {
                await this.readTrailer();
                return null;
            }

            if (this.$chunked) {
                return await this.readChunk();
            } else {
                return await this.readFixedBody();
            }
        } catch (error) {
            this.$state = ReadState.ERROR;
            this.emit('error', error as Error);
            this.$endedrejecter?.(error);
            throw error;
        }
    }

    /**
     * 读取完整的消息体
     */
    async readFullBody(maxsize = 10 * 1024 * 1024): Promise<Uint8Array> {
        const chunks: Uint8Array[] = [];
        let totalsize = 0;

        while (true) {
            const chunk = await this.readBody();
            if (!chunk) break;

            totalsize += chunk.length;
            if (totalsize > maxsize) {
                throw new Error(`Body size exceeds limit: ${maxsize}`);
            }

            chunks.push(chunk);
        }

        if (chunks.length === 0) return new Uint8Array(0);
        if (chunks.length === 1) return chunks[0];

        const result = new Uint8Array(totalsize);
        let offset = 0;
        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }

    /**
     * 写入请求
     */
    async writeRequest(method: string, url: string, headers: HTTPHeaders = {}, body?: Uint8Array | string): Promise<void> {
        assert(this.$role === HTTPClient.ROLE_CLIENT, "Only clients can write requests");
        assert(!this.$sent, "Cannot write request: request already sent");
        this.$sent = true;
        this.emit('request', {
            method, url, headers, version: 'HTTP/1.1'
        })

        // 写入请求行
        await this.$pipe.writeLine(`${method} ${url} HTTP/1.1`);
        this.emit('write');

        // 写入头部
        if(typeof body === 'string')
            body = new TextEncoder().encode(body);
        await this.writeHeaders(headers, body);
        this.emit('write');

        // 写入消息体
        if (body) {
            await this.writeBody(body);
            this.emit('write');
        }
    }

    /**
     * 写入响应
     */
    async writeResponse(code: number, message: string, headers: HTTPHeaders = {}, body?: Uint8Array | string): Promise<void> {
        assert(this.$role === HTTPClient.ROLE_SERVER, "Only servers can write responses");
        assert(!this.$sent, "Cannot write response: response already sent");
        assert(code != 204 || body, "204 response must not have a body");
        // assert(code >= 100 && code < 600, "Invalid response code");
        this.$sent = true;
        this.emit('response', {
            code, message, headers, version: 'HTTP/1.1'
        })

        // 写入状态行
        await this.$pipe.writeLine(`HTTP/1.1 ${code} ${message}`);
        this.emit('write');

        // 写入头部
        if(typeof body === 'string')
            body = new TextEncoder().encode(body);
        await this.writeHeaders(headers, body);
        this.emit('write');

        // 写入消息体
        if (body) {
            await this.writeBody(body);
            this.emit('write');
        }
    }

    /**
     * 写入头部
     */
    private async writeHeaders(headers: HTTPHeaders, body?: Uint8Array): Promise<void> {
        const normalized = new Map<string, string[]>();
        
        // 规范化头部
        for (const [key, value] of Object.entries(headers)) {
            const lower = key.toLowerCase();
            const values = Array.isArray(value) ? value : [value];
            normalized.set(lower, values);
        }

        // 自动添加 Content-Length
        if (
            this.$protocol == Protocol.HTTP &&
            !normalized.has('content-length') && !normalized.has('transfer-encoding')
        ) {
            const length = body?.length ?? '0';
            normalized.set('content-length', [length.toString()]);
        }

        // 写入所有头部
        for (const [key, values] of normalized) {
            for (const value of values) {
                await this.$pipe.writeLine(`${key}: ${value}`);
            }
        }

        // 空行表示头部结束
        await this.$pipe.writeLine('');
    }

    /**
     * 写入消息体
     */
    private async writeBody(body: Uint8Array | string): Promise<void> {
        await this.$pipe.write(body);
    }

    /**
     * 写入分块数据
     */
    async writeChunk(chunk: Uint8Array | string): Promise<void> {
        const data = typeof chunk === 'string' 
            ? new TextEncoder().encode(chunk) 
            : chunk;

        await this.$pipe.writeLine(data.length.toString(16));
        await this.$pipe.write(data);
        await this.$pipe.writeLine('');
    }

    /**
     * 结束分块传输
     */
    async endChunked(trailers?: HTTPHeaders): Promise<void> {
        await this.$pipe.writeLine('0');
        
        if (trailers) {
            for (const [key, value] of Object.entries(trailers)) {
                const values = Array.isArray(value) ? value : [value];
                for (const v of values) {
                    await this.$pipe.writeLine(`${key}: ${v}`);
                }
            }
        }
        
        await this.$pipe.writeLine('');
    }

    /**
     * 跳过剩余的消息体
     */
    async skipBody(): Promise<void> {
        while (await this.readBody()) {
            // 丢弃数据
        }
    }

    // ==================== WebSocket 支持 ====================

    /**
     * 升级到 WebSocket（服务器端）
     */
    async ws(): Promise<void> {
        assert(!this.$sent, "Cannot upgrade to WebSocket: response already sent")
        if (this.$role !== HTTPClient.ROLE_SERVER) {
            throw new Error("Only servers can accept WebSocket");
        }

        const key = this.getHeader('sec-websocket-key');
        if (!key) throw new Error("Missing Sec-WebSocket-Key");

        const accept = HTTPClient.generateWSaccept(key);

        await this.writeResponse(101, 'Switching Protocols', {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Accept': accept
        });

        this.$protocol = Protocol.WEBSOCKET;
        this.$state = ReadState.UPGRADED;
        this.emit('upgrade');
    }

    /**
     * 发起 WebSocket 升级（客户端）
     */
    async wsClient(url: string): Promise<void> {
        if (this.$role !== HTTPClient.ROLE_CLIENT) {
            throw new Error("Only clients can upgrade to WebSocket");
        }

        const key = HTTPClient.generateWSkey();

        await this.writeRequest('GET', url, {
            'Upgrade': 'websocket',
            'Connection': 'Upgrade',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Version': '13'
        });

        await this.start();

        const accept = this.getHeader('sec-websocket-accept');
        const expectedAccept = HTTPClient.generateWSaccept(key);

        if (accept !== expectedAccept) {
            throw new Error("Invalid WebSocket handshake");
        }
    }

    /**
     * 生成 WebSocket 密钥
     */
    static generateWSkey(): string {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        return btoa(String.fromCharCode(...bytes));
    }

    /**
     * 生成 WebSocket Accept
     */
    static generateWSaccept(key: string): string {
        const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
        const hashing = createHash('sha1');
        const hash = hashing.update(key + GUID).bytes();
        return btoa(String.fromCharCode(...hash));
    }

    /**
     * 读取 WebSocket 帧
     */
    private async readWSframe(): Promise<WSFrame> {
        // 读取前两个字节
        const header = await this.$pipe.read(2);
        if (!header || header.length !== 2) {
            throw new Error("Connection closed");
        }

        const byte1 = header[0];
        const byte2 = header[1];

        const fin = (byte1 & 0x80) !== 0;
        const opcode = byte1 & 0x0F;
        const masked = (byte2 & 0x80) !== 0;
        let payloadlen = byte2 & 0x7F;

        // 读取扩展长度
        if (payloadlen === 126) {
            const extlen = await this.$pipe.read(2);
            if (!extlen || extlen.length !== 2) {
                throw new Error("Connection closed");
            }
            payloadlen = (extlen[0] << 8) | extlen[1];
        } else if (payloadlen === 127) {
            const extlen = await this.$pipe.read(8);
            if (!extlen || extlen.length !== 8) {
                throw new Error("Connection closed");
            }
            // 简化处理，不支持超大帧
            payloadlen = 0;
            for (let i = 4; i < 8; i++) {
                payloadlen = (payloadlen << 8) | extlen[i];
            }
        }

        // 读取掩码密钥
        let maskkey: Uint8Array | null | undefined;
        if (masked) {
            maskkey = await this.$pipe.read(4);
            if (!maskkey || maskkey.length !== 4) {
                throw new Error("Connection closed");
            }
        }

        // 读取负载数据
        const payload = await this.$pipe.read(payloadlen);
        if (!payload || payload.length !== payloadlen) {
            throw new Error("Connection closed");
        }

        // 解除掩码
        if (masked && maskkey) {
            for (let i = 0; i < payload.length; i++) {
                payload[i] ^= maskkey[i % 4];
            }
        }

        return { fin, opcode, masked, payload };
    }

    /**
     * 写入 WebSocket 帧
     */
    private async writeWSframe(opcode: WSOpcode, payload: Uint8Array, mask = false): Promise<void> {
        const header: number[] = [];
        
        // 第一个字节：FIN + Opcode
        header.push(0x80 | opcode);

        // 第二个字节：MASK + Payload Length
        let byte2 = mask ? 0x80 : 0x00;
        
        if (payload.length < 126) {
            byte2 |= payload.length;
            header.push(byte2);
        } else if (payload.length < 65536) {
            byte2 |= 126;
            header.push(byte2);
            header.push((payload.length >> 8) & 0xFF);
            header.push(payload.length & 0xFF);
        } else {
            byte2 |= 127;
            header.push(byte2);
            // 64位长度（简化处理）
            header.push(0, 0, 0, 0);
            header.push((payload.length >> 24) & 0xFF);
            header.push((payload.length >> 16) & 0xFF);
            header.push((payload.length >> 8) & 0xFF);
            header.push(payload.length & 0xFF);
        }

        // 如果需要掩码
        let maskedPayload = payload;
        if (mask) {
            const maskkey = new Uint8Array(4);
            crypto.getRandomValues(maskkey);
            header.push(...maskkey);
            
            maskedPayload = new Uint8Array(payload.length);
            for (let i = 0; i < payload.length; i++) {
                maskedPayload[i] = payload[i] ^ maskkey[i % 4];
            }
        }

        await this.$pipe.write(new Uint8Array(header));
        await this.$pipe.write(maskedPayload);
    }

    /**
     * 读取 WebSocket 消息
     */
    async readWSmessage(): Promise<WSMessage | null> {
        if (this.$protocol !== Protocol.WEBSOCKET) {
            throw new Error("Not in WebSocket mode");
        }

        if (this.$wsclosed) return null;

        while (true) {
            const frame = await this.readWSframe();

            // 控制帧
            if (frame.opcode >= 0x8) {
                switch (frame.opcode) {
                    case WSOpcode.CLOSE:
                        this.$wsclosed = true;
                        await this.writeWSframe(WSOpcode.CLOSE, new Uint8Array(), this.$role === HTTPClient.ROLE_CLIENT);
                        return null;
                    
                    case WSOpcode.PING:
                        await this.writeWSframe(WSOpcode.PONG, frame.payload, this.$role === HTTPClient.ROLE_CLIENT);
                        continue;
                    
                    case WSOpcode.PONG:
                        continue;
                }
            }

            // 数据帧
            if (frame.opcode === WSOpcode.CONTINUATION) {
                if (!this.$wsfragmentopcode) {
                    throw new Error("Unexpected continuation frame");
                }
                this.$wsfragments.push(frame.payload);
            } else {
                if (this.$wsfragmentopcode) {
                    throw new Error("Expected continuation frame");
                }
                if (!frame.fin) {
                    this.$wsfragmentopcode = frame.opcode;
                    this.$wsfragments = [frame.payload];
                } else {
                    return { opcode: frame.opcode, data: frame.payload };
                }
            }

            // 如果是最后一个分片
            if (frame.fin && this.$wsfragmentopcode) {
                const totalsize = this.$wsfragments.reduce((sum, f) => sum + f.length, 0);
                const data = new Uint8Array(totalsize);
                let offset = 0;
                for (const fragment of this.$wsfragments) {
                    data.set(fragment, offset);
                    offset += fragment.length;
                }
                
                const opcode = this.$wsfragmentopcode;
                this.$wsfragmentopcode = undefined;
                this.$wsfragments = [];
                
                return { opcode, data };
            }
        }
    }

    /**
     * 发送 WebSocket 消息
     */
    async sendWSmessage(data: string | Uint8Array, opcode?: WSOpcode): Promise<void> {
        if (this.$protocol !== Protocol.WEBSOCKET) {
            throw new Error("Not in WebSocket mode");
        }

        const payload = typeof data === 'string' 
            ? new TextEncoder().encode(data) 
            : data;

        const op = opcode ?? (typeof data === 'string' ? WSOpcode.TEXT : WSOpcode.BINARY);
        const mask = this.$role === HTTPClient.ROLE_CLIENT;

        await this.writeWSframe(op, payload, mask);
    }

    /**
     * 关闭 WebSocket 连接
     */
    async closews(code = 1000, reason = ""): Promise<void> {
        if (this.$protocol !== Protocol.WEBSOCKET || this.$wsclosed) {
            return;
        }

        const payload = new Uint8Array(2 + reason.length);
        payload[0] = (code >> 8) & 0xFF;
        payload[1] = code & 0xFF;
        
        if (reason) {
            const reasonBytes = new TextEncoder().encode(reason);
            payload.set(reasonBytes, 2);
        }

        await this.writeWSframe(WSOpcode.CLOSE, payload, this.$role === HTTPClient.ROLE_CLIENT);
        this.$wsclosed = true;
    }

    /**
     * 发送 WebSocket Ping
     */
    async pingWS(data?: Uint8Array): Promise<void> {
        if (this.$protocol !== Protocol.WEBSOCKET) {
            throw new Error("Not in WebSocket mode");
        }

        await this.writeWSframe(WSOpcode.PING, data || new Uint8Array(), this.$role === HTTPClient.ROLE_CLIENT);
    }

    // ==================== SSE 支持 ====================

    async sse(){
        assert(!this.$sent, "Cannot upgrade to SSE: response already sent")
        assert(this.$protocol == Protocol.HTTP, "Only HTTP protocol can accept SSE");
        if (this.$role !== HTTPClient.ROLE_SERVER) {
            throw new Error("Only servers can accept SSE");
        }

        this.$protocol = Protocol.SSE;
        this.$state = ReadState.UPGRADED;
        await this.writeResponse(200, 'OK', {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        
        this.emit('upgrade');
    }

    /**
     * 读取 SSE 消息
     */
    async readSSEmessage(): Promise<SSEMessage | null> {
        if (this.$protocol !== Protocol.SSE) {
            throw new Error("Not in SSE mode");
        }

        let event: string | undefined;
        let data: string[] = [];
        let id: string | undefined;
        let retry: number | undefined;

        while (true) {
            const chunk = await this.readBody();
            if (!chunk) return null;

            this.$ssebuffer += new TextDecoder().decode(chunk);

            // 处理缓冲区中的行
            while (true) {
                const lineEnd = this.$ssebuffer.indexOf('\n');
                if (lineEnd === -1) break;

                let line = this.$ssebuffer.substring(0, lineEnd);
                this.$ssebuffer = this.$ssebuffer.substring(lineEnd + 1);

                // 移除 \r
                if (line.endsWith('\r')) {
                    line = line.substring(0, line.length - 1);
                }

                // 空行表示消息结束
                if (!line) {
                    if (data.length > 0) {
                        return {
                            event,
                            data: data.join('\n'),
                            id,
                            retry
                        };
                    }
                    continue;
                }

                // 注释行
                if (line.startsWith(':')) continue;

                // 解析字段
                const colonIndex = line.indexOf(':');
                if (colonIndex === -1) continue;

                const field = line.substring(0, colonIndex);
                let value = line.substring(colonIndex + 1);
                
                // 移除前导空格
                if (value.startsWith(' ')) {
                    value = value.substring(1);
                }

                switch (field) {
                    case 'event':
                        event = value;
                        break;
                    case 'data':
                        data.push(value);
                        break;
                    case 'id':
                        id = value;
                        break;
                    case 'retry':
                        retry = parseInt(value);
                        break;
                }
            }
        }
    }

    /**
     * 发送 SSE 消息
     */
    async sendSSEmessage(data: string, event?: string, id?: string): Promise<void> {
        if (this.$role !== HTTPClient.ROLE_SERVER) {
            throw new Error("Only servers can send SSE messages");
        }

        let message = '';
        
        if (event) {
            message += `event: ${event}\n`;
        }
        
        if (id) {
            message += `id: ${id}\n`;
        }

        const lines = data.split('\n');
        for (const line of lines) {
            message += `data: ${line}\n`;
        }

        message += '\n';

        await this.$pipe.write(message);
    }

    // ==================== 通用方法 ====================

    /**
     * 关闭连接
     */
    close(): void {
        this.$pipe.close();
        this.$endedresolver?.();
    }

    /**
     * 获取请求信息（服务器端）
     */
    get request(): HTTPRequest | null {
        if (!this.$requestline) return null;
        
        const headers: HTTPHeaders = {};
        for (const [key, values] of this.$headers) {
            headers[key] = values.length === 1 ? values[0] : values;
        }
        
        return {
            method: this.$requestline.method,
            url: this.$requestline.url,
            version: this.$requestline.version,
            headers
        };
    }

    /**
     * 获取响应信息（客户端）
     */
    get response(): HTTPResponse | null {
        if (!this.$statusline) return null;
        
        const headers: HTTPHeaders = {};
        for (const [key, values] of this.$headers) {
            headers[key] = values.length === 1 ? values[0] : values;
        }
        
        return {
            code: this.$statusline.code,
            message: this.$statusline.message,
            version: this.$statusline.version,
            headers
        };
    }

    /**
     * 获取所有头部（作为对象）
     */
    get headers(): HTTPHeaders {
        const headers: HTTPHeaders = {};
        for (const [key, values] of this.$headers) {
            headers[key] = values.length === 1 ? values[0] : values;
        }
        return headers;
    }

    get sent(){
        return this.$sent;
    }

    /**
     * 检查头部是否存在（大小写不敏感）
     */
    hasHeader(name: string): boolean {
        return this.$headers.has(name.toLowerCase());
    }

    /**
     * 删除头部（大小写不敏感）
     */
    deleteHeader(name: string): void {
        this.$headers.delete(name.toLowerCase());
    }

    /**
     * 检查是否保持连接
     */
    get keepalive(): boolean {
        return this.$keepalive;
    }

    /**
     * 检查是否完成
     */
    get isdone(): boolean {
        return this.$state === ReadState.DONE;
    }

    /**
     * 获取当前状态
     */
    get state(): ReadState {
        return this.$state;
    }

    /**
     * 获取当前协议
     */
    get protocol(): Protocol {
        return this.$protocol;
    }

    /**
     * 检查是否为 WebSocket
     */
    get isWS(): boolean {
        return this.$protocol === Protocol.WEBSOCKET;
    }

    /**
     * 检查是否为 SSE
     */
    get issse(): boolean {
        return this.$protocol === Protocol.SSE;
    }

    /**
     * 获取底层管道
     */
    get pipe(): AsyncPipe {
        return this.$pipe;
    }

    /**
     * 获取角色
     */
    get role(): number {
        return this.$role;
    }

    /**
     * 等待并读取消息（根据协议自动选择）
     */
    async read(): Promise<Uint8Array | WSMessage | SSEMessage | null> {
        switch (this.$protocol) {
            case Protocol.WEBSOCKET:
                return await this.readWSmessage();
            case Protocol.SSE:
                return await this.readSSEmessage();
            default:
                return await this.readBody();
        }
    }

    /**
     * 发送消息（根据协议自动选择）
     */
    async send(data: string | Uint8Array): Promise<void> {
        switch (this.$protocol) {
            case Protocol.WEBSOCKET:
                await this.sendWSmessage(data);
                break;
            case Protocol.SSE:
                if (typeof data === 'string') {
                    await this.sendSSEmessage(data);
                } else {
                    throw new Error("SSE only supports string data");
                }
                break;
            default:
                throw new Error("Not in upgraded protocol mode");
        }
    }

    /**
     * 创建异步迭代器（用于 for await...of）
     */
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array | WSMessage | SSEMessage> {
        while (true) {
            const message = await this.read();
            if (!message) break;
            yield message;
        }
    }

    /**
     * 便捷方法：创建 ReadableStream
     */
    createStream(): ReadableStream<Uint8Array | WSMessage | SSEMessage> {
        const self = this;
        return new ReadableStream({
            async pull(controller) {
                try {
                    const message = await self.read();
                    if (message) {
                        controller.enqueue(message);
                    } else {
                        controller.close();
                    }
                } catch (error) {
                    controller.error(error);
                }
            },
            cancel() {
                self.close();
            }
        });
    }
}

// 导出所有类型和枚举
export {
    HTTPClient,
    HTTPHeaders,
    HTTPRequest,
    HTTPResponse,
    SSEMessage,
    WSMessage,
    WSFrame,
    WSOpcode,
    ReadState,
    Protocol
};