import { EventBase } from "./event";

export enum Level {
    LOG = "log",
    INFO = "info",
    WARN = "warn",
    ERROR = "error"
};

export type IConsole = typeof console;

export interface Message {
    level: Level,
    message: any[],
    error: boolean,
    html: string,
    uuid: string
};

export default class Console extends EventBase<{
    log: Message,
    overflow: Message,
    clear: Message[]
}> {
    static escapeHtml(str: any) {
        if (typeof str === 'string') {
            return str.replace(/[&<>"'`]/g, (match) => {
                switch (match) {
                    case '&': return '&amp;';
                    case '<': return '&lt;';
                    case '>': return '&gt;';
                    case '"': return '&quot;';
                    case "'": return '&#39;';
                    case '`': return '&#96;';
                    default: return match;
                }
            });
        }
        return str;
    };

    static format(...args: any[]): string {
        let formattedString = '';

        // 处理第一个参数中的格式说明符
        if (args.length > 0 && typeof args[0] === 'string') {
            const formatString = args[0];
            let argIndex = 1;
            let result = '';

            // 处理格式说明符 (%s, %d, %i, %f, %o, %O, %c)
            let i = 0;
            while (i < formatString.length) {
                if (formatString[i] === '%' && i + 1 < formatString.length) {
                    const specifier = formatString[i + 1];
                    i += 2;

                    if (argIndex < args.length) {
                        const arg = args[argIndex++];
                        switch (specifier) {
                            case 's': // 字符串
                                result += Console.escapeHtml(String(arg));
                                break;
                            case 'd': // 整数
                            case 'i':
                                result += Console.escapeHtml(parseInt(arg, 10));
                                break;
                            case 'f': // 浮点数
                                result += Console.escapeHtml(parseFloat(arg));
                                break;
                            case 'o': // 对象
                            case 'O':
                                try {
                                    result += `<pre>${Console.escapeHtml(JSON.stringify(arg, null, 2))}</pre>`;
                                } catch {
                                    result += Console.escapeHtml(String(arg));
                                }
                                break;
                            case 'c': // CSS样式 (忽略样式)
                                argIndex++; // 跳过样式参数
                                break;
                            default:
                                result += `%${specifier}`;
                        }
                    } else {
                        result += `%${specifier}`;
                    }
                } else {
                    result += Console.escapeHtml(formatString[i++]);
                }
            }

            // 添加剩余的参数
            while (argIndex < args.length) {
                result += ' ' + Console.escapeHtml(String(args[argIndex++]));
            }

            formattedString = result;
        } else {
            // 没有格式说明符，简单拼接所有参数
            formattedString = args.map(arg => {
                if (typeof arg === 'object' && arg !== null) {
                    try {
                        return `<pre>${JSON.stringify(arg, null, 2).replace(/[&<>"'`]/g, (match) => {
                            switch (match) {
                                case '&': return '&amp;';
                                case '<': return '&lt;';
                                case '>': return '&gt;';
                                case '"': return '&quot;';
                                case "'": return '&#39;';
                                case '`': return '&#96;';
                                default: return match;
                            }
                        })}</pre>`;
                    } catch {
                        return String(arg).replace(/[&<>"'`]/g, (match) => {
                            switch (match) {
                                case '&': return '&amp;';
                                case '<': return '&lt;';
                                case '>': return '&gt;';
                                case '"': return '&quot;';
                                case "'": return '&#39;';
                                case '`': return '&#96;';
                                default: return match;
                            }
                        });
                    }
                }
                return String(arg).replace(/[&<>"'`]/g, (match) => {
                    switch (match) {
                        case '&': return '&amp;';
                        case '<': return '&lt;';
                        case '>': return '&gt;';
                        case '"': return '&quot;';
                        case "'": return '&#39;';
                        case '`': return '&#96;';
                        default: return match;
                    }
                });
            }).join(' ');
        }

        // 将换行符转换为<br>标签
        formattedString = formattedString.replace(/\n/g, '<br>');

        return formattedString;
    }

    private $console: IConsole;
    private $logQueue: Message[] = [];
    private $maxLogQueueLength = 20;

    constructor() {
        super();
        this.$console = tjs.createConsole({
            clearConsole: () => this.clear(),
            printer: (level, args, options) => {
                if (this.$logQueue.length >= this.$maxLogQueueLength){
                    this.emit('overflow', this.$logQueue.shift());
                }
                const msg: Message = {
                    level: level as Level,
                    message: args,
                    error: !!options.isWarn,
                    html: Console.format.apply(Console, args),
                    uuid: crypto.randomUUID()
                };
                this.$logQueue.push(msg);
                this.emit('log', msg);
            }
        })
    }

    clear() {
        this.emit('clear', this.$logQueue.slice());
    }

    get log() {
        return this.$logQueue;
    }

    get console() {
        return this.$console;
    }
}