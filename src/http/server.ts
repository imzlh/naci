import assert from "../utils/assert";
import AsyncPipe from "./pipe";

export abstract class Client {
    constructor($pipe: AsyncPipe) {}

    abstract ended: Promise<void>;
    abstract close(): void;
};

export default class Server {
    private $clients: Client[] = [];
    private $running = false;
    private $abortController = new AbortController();

    static async create(
        addr: string,
        port: number,
        handleClass: new(socket: AsyncPipe) => Client,
        options?: tjs.ListenOptions,
    ) {
        const socket = await tjs.listen('tcp', addr, port, options) as tjs.Listener;
        console.log(`Server listening on ${addr}:${port}`);
        return new Server(socket, handleClass);
    }

    constructor(
        private readonly $socket: tjs.Listener,
        private readonly $handleClass: { new(socket: AsyncPipe): Client }
    ) {}

    async run() {
        assert(!this.$running, 'Server is already running');
        this.$running = true;

        try {
            while (this.$running) {
                let clientSocket: tjs.Connection | null = null;
                
                try {
                    clientSocket = await this.$socket.accept();
                    
                    // 双重检查运行状态
                    if (!this.$running || !clientSocket) {
                        clientSocket?.close();
                        continue;
                    }

                    const pipe = new AsyncPipe(clientSocket);
                    const client = new this.$handleClass(pipe);
                    
                    this.setupClientHandling(client);
                    this.$clients.push(client);
                } catch (error) {
                    if (this.$running) {
                        console.error('Error accepting connection:', error);
                    }
                    clientSocket?.close();
                }
            }
        } finally {
            this.cleanup();
        }
    }

    async stop() {
        if (!this.$running) return;
        
        this.$running = false;
        this.$abortController.abort();
        
        try {
            this.$socket.close();
        } catch (error) {
            console.error('Error closing server socket:', error);
        }

        // 安全拷贝当前客户端列表
        const activeClients = [...this.$clients];
        await Promise.allSettled([
            ...activeClients.map(client => this.safeCloseClient(client)),
            ...activeClients.map(client => client.ended.catch(() => {}))
        ]);
        
        this.$clients = [];
    }

    get clientCount() {
        return this.$clients.length;
    }

    private setupClientHandling(client: Client) {
        client.ended
            .catch(e => void e)
            .finally(() => {
                const index = this.$clients.indexOf(client);
                if (index !== -1) {
                    this.$clients.splice(index, 1);
                }
            });
    }

    private async safeCloseClient(client: Client) {
        try {
            client.close();
        } catch (error) {
            console.error('Error closing client:', error);
        }
    }

    private cleanup() {
        this.$running = false;
        this.$abortController = new AbortController();
    }
}
