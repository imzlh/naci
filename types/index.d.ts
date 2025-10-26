/// <reference path="./txikijs.d.ts" />
/// <reference path="./assert.d.ts" />
/// <reference path="./ffi.d.ts" />
/// <reference path="./getopts.d.ts" />
/// <reference path="./hashing.d.ts" />
/// <reference path="./ipaddr.d.ts" />
/// <reference path="./path.d.ts" />
/// <reference path="./posix-socket.d.ts" />
/// <reference path="./sqlite.d.ts" />
/// <reference path="./uuid.d.ts" />

declare global {
    const overrideModuleLoader: (
        resolver: (mname: string, parent: string) => string,
        loader: (module: string) => string
    ) => void;

    /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console) */
    interface Console {
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/assert_static) */
        assert(condition?: boolean, ...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/clear_static) */
        clear(): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/count_static) */
        count(label?: string): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/countReset_static) */
        countReset(label?: string): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/debug_static) */
        debug(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dir_static) */
        dir(item?: any, options?: any): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/dirxml_static) */
        dirxml(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/error_static) */
        error(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/group_static) */
        group(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupCollapsed_static) */
        groupCollapsed(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/groupEnd_static) */
        groupEnd(): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/info_static) */
        info(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/log_static) */
        log(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/table_static) */
        table(tabularData?: any, properties?: string[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/time_static) */
        time(label?: string): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeEnd_static) */
        timeEnd(label?: string): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/timeLog_static) */
        timeLog(label?: string, ...data: any[]): void;
        timeStamp(label?: string): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/trace_static) */
        trace(...data: any[]): void;
        /** [MDN Reference](https://developer.mozilla.org/docs/Web/API/console/warn_static) */
        warn(...data: any[]): void;
    }

    const console: Console;
}

export {};
