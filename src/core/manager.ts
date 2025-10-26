import { getError } from "../utils/error";
import { ensureDir } from "../utils/fs";
import { App, AppInfo, AppState } from "./app";

export interface AppManagerConfig {
    appBaseDir?: string;
    autoRestart?: boolean;
    maxRestartAttempts?: number;
    healthCheckInterval?: number;
}

export default class AppManager {
    private $apps: Map<string, App> = new Map();
    private $config: Required<AppManagerConfig>;
    private $healthCheckTimer?: number;

    constructor(config: AppManagerConfig = {}, private $console: Console = console) {
        this.$config = {
            appBaseDir: config.appBaseDir || tjs.cwd + '/app',
            autoRestart: config.autoRestart ?? false,
            maxRestartAttempts: config.maxRestartAttempts ?? 3,
            healthCheckInterval: config.healthCheckInterval ?? 30000
        };
        
        App.app_base_dir = this.$config.appBaseDir;
        ensureDir(this.$config.appBaseDir);

        if (this.$config.healthCheckInterval > 0) {
            this.startHealthCheck();
        }
    }

    // 注册应用
    register(name: string): App {
        if (this.$apps.has(name)) {
            throw new Error(`App ${name} already registered`);
        }
        
        const app = new App(name);
        this.$apps.set(name, app);
        return app;
    }

    // 注销应用
    async unregister(name: string): Promise<void> {
        const app = this.$apps.get(name);
        if (!app) {
            throw new Error(`App ${name} not found`);
        }

        await app.uninstall();
        this.$apps.delete(name);
    }

    // 初始化应用
    async init(name: string, info: AppInfo): Promise<void> {
        let app = this.$apps.get(name);
        
        if (!app) {
            app = this.register(name);
        }

        await app.init(info);
    }

    // 启动应用
    async start(name: string): Promise<void> {
        const app = this.$apps.get(name);
        if (!app) {
            throw new Error(`App ${name} not found`);
        }

        await app.run();
    }

    // 停止应用
    async stop(name: string): Promise<void> {
        const app = this.$apps.get(name);
        if (!app) {
            throw new Error(`App ${name} not found`);
        }

        await app.stop();
    }

    // 重启应用
    async restart(name: string): Promise<void> {
        const app = this.$apps.get(name);
        if (!app) {
            throw new Error(`App ${name} not found`);
        }

        await app.restart();
    }

    // 启动所有应用
    async startAll(): Promise<void> {
        const promises = Array.from(this.$apps.values())
            .filter(app => app.state === AppState.INITIALIZED || app.state === AppState.STOPPED)
            .map(app => this.start(app.name).catch(err => {
                console.error(`Failed to start ${app.name}:`, err);
            }));

        await Promise.all(promises);
    }

    // 停止所有应用
    async stopAll(): Promise<void> {
        const promises = Array.from(this.$apps.values())
            .filter(app => app.state === AppState.RUNNING)
            .map(app => this.stop(app.name).catch(err => {
                console.error(`Failed to stop ${app.name}:`, err);
            }));

        await Promise.all(promises);
    }

    // 获取应用
    get(name: string): App | undefined {
        return this.$apps.get(name);
    }

    // 列出所有应用
    list(): App[] {
        return Array.from(this.$apps.values());
    }

    // 获取应用状态
    getStatus(name?: string) {
        if (name) {
            const app = this.$apps.get(name);
            if (!app) return null;
            
            return {
                name: app.name,
                state: app.state,
                info: app.info,
                stats: app.stats
            };
        }

        return Array.from(this.$apps.values()).map(app => ({
            name: app.name,
            state: app.state,
            info: app.info,
            stats: app.stats
        }));
    }

    // 健康检查
    private startHealthCheck(): void {
        this.$healthCheckTimer = setInterval(() => {
            this.$apps.forEach(async (app) => {
                if (app.state === AppState.STOPPED && this.$config.autoRestart) {
                    const stats = app.stats;
                    if (stats.restartCount < this.$config.maxRestartAttempts) {
                        try {
                            console.log(`Auto-restarting app: ${app.name}`);
                            await app.restart();
                        } catch (error) {
                            console.error(`Failed to auto-restart ${app.name}:`, getError(error));
                        }
                    } else {
                        console.error(`App ${app.name} exceeded max restart attempts`);
                    }
                }
            });
        }, this.$config.healthCheckInterval) as any;
    }

    // 停止健康检查
    stopHealthCheck(): void {
        if (this.$healthCheckTimer) {
            clearInterval(this.$healthCheckTimer);
            this.$healthCheckTimer = undefined;
        }
    }

    // 销毁管理器
    async destroy(): Promise<void> {
        this.stopHealthCheck();
        await this.stopAll();
        this.$apps.clear();
    }

    /**
     * 导出
     */
    export(): AppInfo[] {
        return Array.from(this.$apps.values()).map(app => app.info).filter(Boolean) as AppInfo[];
    }

    load(infos: AppInfo[]): void {
        infos.forEach(info => {
            this.init(info.name, info);
        });
    }
}