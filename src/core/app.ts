import path from "tjs:path";
import assert from "../utils/assert";
import { getError } from "../utils/error";
import Console, { IConsole } from "./console";
import { delay } from "../utils/promise";

export interface AppInfoFactory {
    name: string;
    version: string;
    description: string;
    timestamp: number;
}

export interface AppInfo extends AppInfoFactory {
    [key: string]: string | number | boolean;
}

export interface AppInitArgs {
    self: AppInfo;
    console: IConsole;
    wrapper: AppPromiseWrapper;
}

export enum AppState {
    UNINITIALIZED = "UNINITIALIZED",
    INITIALIZED = "INITIALIZED",
    STOPPED = "STOPPED",
    RUNNING = "RUNNING",
    STOPPING = "STOPPING",
}

export type PromiseOrNot<T> = T | Promise<T>;
export type AppPromiseWrapper = <T>(promise: T | Promise<T>) => Promise<T>;


export interface Module {
    default: new (arg: AppInitArgs) => AppModule;
}

export interface AppStats {
    startTime?: number;
    stopTime?: number;
    restartCount: number;
    lastError?: string;
    uptime: number;
}

export class App {
    static app_base_dir = tjs.cwd + '/app';

    private $mod: AppModule | undefined;
    private $currentInfo: AppInfo | undefined;
    private $appState: AppState = AppState.UNINITIALIZED;
    private $stopPromise: { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void };
    private $wrapper: AppPromiseWrapper;
    private $console = new Console();
    private $stats: AppStats = {
        restartCount: 0,
        uptime: 0
    };

    constructor(private $name: string) {
        this.$stopPromise = this.createStopPromise();
        this.$wrapper = this.createWrapper();
    }

    private createStopPromise() {
        const resolvers = Promise.withResolvers<void>();
        return resolvers;
    }

    private createWrapper(): AppPromiseWrapper {
        return async <T>(promise: T | Promise<T>): Promise<T> => {
            try {
                const result = await Promise.race([
                    Promise.resolve(promise),
                    this.$stopPromise.promise.then(() => {
                        throw new Error('App stopped');
                    })
                ]);
                return result;
            } catch (error) {
                if (this.$appState === AppState.STOPPING || this.$appState === AppState.STOPPED) {
                    throw new Error('App stopped');
                }
                throw error;
            }
        };
    }

    private resetStopPromise(): void {
        this.$stopPromise = this.createStopPromise();
        this.$wrapper = this.createWrapper();
    }

    async uninstall(): Promise<void> {
        if (this.$mod) {
            try {
                if (this.$appState === AppState.RUNNING) {
                    await this.stop();
                }
                this.$mod = undefined;
                this.$currentInfo = undefined;
                this.$appState = AppState.UNINITIALIZED;
            } catch (error) {
                this.$stats.lastError = getError(error);
                throw error;
            }
        }
    }

    async init(curInfo: AppInfo): Promise<void> {
        if (this.$appState === AppState.RUNNING) {
            throw new Error('Cannot initialize while running');
        }

        let module: Module;
        await this.uninstall();
        
        try {
            const modPath = path.join(App.app_base_dir, this.$name + '.' + curInfo.timestamp + '.js');
            module = await import(modPath);
            
            if (!module.default || typeof module.default !== 'function') {
                throw new Error('Module must export a default class');
            }
        } catch (e) {
            const error = `Failed to load app module ${this.$name}: ${getError(e)}`;
            this.$stats.lastError = error;
            throw new Error(error);
        }

        try {
            this.$currentInfo = curInfo;
            this.$mod = new module.default({
                wrapper: this.$wrapper,
                console: this.$console.console,
                self: curInfo
            });
            await this.$mod?.init();
            this.$appState = AppState.INITIALIZED;
            this.resetStopPromise();
        } catch (e) {
            const error = `Failed to initialize app ${this.$name}: ${getError(e)}`;
            this.$stats.lastError = error;
            this.$mod = undefined;
            this.$currentInfo = undefined;
            throw new Error(error);
        }
    }

    async run(): Promise<void> {
        if (this.$appState === AppState.RUNNING) {
            return;
        }
        
        assert(this.$mod, "App module not initialized");
        assert(this.$currentInfo, "App info not initialized");
        
        if (this.$appState !== AppState.INITIALIZED && this.$appState !== AppState.STOPPED) {
            throw new Error(`Cannot run app in state: ${this.$appState}`);
        }

        try {
            this.$appState = AppState.RUNNING;
            this.resetStopPromise();
            this.$stats.startTime = Date.now();
            await Promise.race([
                // Promise.resolve(this.$mod.run()).then(() => this.$appState = AppState.STOPPED),
                this.$mod.run(),
                delay(1000)
            ]);
        } catch (error) {
            this.$stats.lastError = getError(error);
            this.$appState = AppState.STOPPED;
            throw error;
        }
    }

    async stop(): Promise<void> {
        if (this.$appState === AppState.STOPPED || this.$appState === AppState.UNINITIALIZED) {
            return;
        }

        if (this.$appState === AppState.RUNNING && this.$mod) {
            try {
                this.$appState = AppState.STOPPING;
                this.$stopPromise.resolve();
                await this.$mod.stop();
                this.$stats.stopTime = Date.now();
                if (this.$stats.startTime) {
                    this.$stats.uptime += this.$stats.stopTime - this.$stats.startTime;
                }
                this.$appState = AppState.STOPPED;
            } catch (error) {
                this.$stats.lastError = getError(error);
                this.$appState = AppState.STOPPED;
                throw error;
            }
        }
    }

    async restart(): Promise<void> {
        await this.stop();
        this.$stats.restartCount++;
        this.resetStopPromise();
        await this.run();
    }

    get name(): string {
        return this.$name;
    }

    get state(): AppState {
        return this.$appState;
    }

    get info(): AppInfo | undefined {
        return this.$currentInfo;
    }

    get stats(): AppStats {
        return { ...this.$stats };
    }

    get console(){
        return this.$console;
    }
}

export abstract class AppModule {
    constructor(protected $wrap: AppInitArgs, protected $console: IConsole) {}

    public init(): PromiseOrNot<void> {}
    public abstract run(): PromiseOrNot<void>;
    public stop(): PromiseOrNot<void> {}
}