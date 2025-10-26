export interface Address {
    ip: string;
    port: number;
}

export interface Connection {
    read(buf: Uint8Array): Promise<number | null>;
    write(buf: Uint8Array): Promise<number>;
    setKeepAlive(enable: boolean, delay: number): void;
    setNoDelay(enable?: boolean): void;
    shutdown(): void;
    close(): void;
    localAddress: Address;
    remoteAddress: Address;
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
}

/**
 * Pipe 类 - 基于 Connection 的高级读取功能封装
 */
export default class Pipe {
    private $buffer: Uint8Array;
    private $bufferStart = 0;
    private $bufferEnd = 0;
    private $closed = false;
    private $textDecoder = new TextDecoder();
    private $textEncoder = new TextEncoder();

    /**
     * 构造函数
     * @param $conn - TJS Connection 对象
     * @param $bufferSize - 内部缓冲区大小，默认 4KB
     */
    constructor(private $conn: Connection, private $bufferSize: number = 4096) {
        this.$buffer = new Uint8Array($bufferSize);
    }

    /**
     * 从连接中读取数据填充内部缓冲区
     * @returns 读取的字节数，null 表示 EOF
     */
    private async fill(): Promise<number | null> {
        if (this.$closed) {
            throw new Error('Pipe is closed');
        }

        // 如果缓冲区还有未消费的数据，先移动到开头
        if (this.$bufferStart > 0) {
            const remaining = this.$bufferEnd - this.$bufferStart;
            if (remaining > 0) {
                this.$buffer.copyWithin(0, this.$bufferStart, this.$bufferEnd);
            }
            this.$bufferEnd = remaining;
            this.$bufferStart = 0;
        }

        // 读取新数据
        const n = await this.$conn.read(this.$buffer.subarray(this.$bufferEnd));
        if (n === null) {
            return null;
        }
        this.$bufferEnd += n;
        return n;
    }

    /**
     * 确保缓冲区至少有 n 个字节
     * @param n - 需要的字节数
     * @returns 是否成功，false 表示 EOF
     */
    private async ensureBytes(n: number): Promise<boolean> {
        while (this.$bufferEnd - this.$bufferStart < n) {
            const result = await this.fill();
            if (result === null) {
                return false;
            }
        }
        return true;
    }

    /**
     * 读取指定大小的数据
     * @param size - 要读取的字节数
     * @returns 读取的数据，如果 EOF 则返回 null
     */
    private async readExact(size: number): Promise<Uint8Array | null> {
        if (size <= 0) {
            return new Uint8Array(0);
        }

        const result = new Uint8Array(size);
        let offset = 0;

        while (offset < size) {
            // 先从缓冲区读取
            const available = this.$bufferEnd - this.$bufferStart;
            if (available > 0) {
                const toCopy = Math.min(available, size - offset);
                result.set(
                    this.$buffer.subarray(this.$bufferStart, this.$bufferStart + toCopy),
                    offset
                );
                this.$bufferStart += toCopy;
                offset += toCopy;
            }

            // 如果还需要更多数据，填充缓冲区
            if (offset < size) {
                const n = await this.fill();
                if (n === null) {
                    return offset > 0 ? result.subarray(0, offset) : null;
                }
            }
        }

        return result;
    }

    /**
     * 读取一行数据（以 \n 或 \r\n 结尾）
     * @param maxLength - 最大行长度限制，默认 64KB，防止内存溢出
     * @returns 读取的行（不包含换行符），如果 EOF 则返回 null
     */
    async readline(maxLength: number = 65536): Promise<string | null> {
        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        while (true) {
            // 在当前缓冲区中查找换行符
            let newlineIndex = -1;
            let newlineLength = 1;

            for (let i = this.$bufferStart; i < this.$bufferEnd; i++) {
                if (this.$buffer[i] === 0x0a) { // \n
                    newlineIndex = i;
                    newlineLength = 1;
                    break;
                } else if (this.$buffer[i] === 0x0d) { // \r
                    if (i + 1 < this.$bufferEnd && this.$buffer[i + 1] === 0x0a) {
                        newlineIndex = i;
                        newlineLength = 2;
                        break;
                    }
                }
            }

            if (newlineIndex !== -1) {
                // 找到换行符
                const lineData = this.$buffer.subarray(this.$bufferStart, newlineIndex);
                chunks.push(lineData.slice());
                totalLength += lineData.length;
                this.$bufferStart = newlineIndex + newlineLength;

                // 合并所有块并解码
                if (chunks.length === 1) {
                    return this.$textDecoder.decode(chunks[0]);
                } else {
                    const combined = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    return this.$textDecoder.decode(combined);
                }
            }

            // 保存当前缓冲区的数据
            const available = this.$bufferEnd - this.$bufferStart;
            if (available > 0) {
                chunks.push(this.$buffer.subarray(this.$bufferStart, this.$bufferEnd).slice());
                totalLength += available;
                this.$bufferStart = this.$bufferEnd;
            }

            // 检查长度限制
            if (totalLength >= maxLength) {
                throw new Error(`Line exceeds maximum length of ${maxLength} bytes`);
            }

            // 读取更多数据
            const n = await this.fill();
            if (n === null) {
                // EOF
                if (totalLength === 0) {
                    return null;
                }
                // 返回剩余数据作为最后一行
                const combined = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }
                return this.$textDecoder.decode(combined);
            }
        }
    }

    /**
     * 读取所有可用数据，或读取指定大小数据
     * @returns 读取的数据，如果没有数据则返回null
     */
    async read(size = 0): Promise<Uint8Array | null> {
        const available = this.$bufferEnd - this.$bufferStart;

        if (size > 0) {
            return this.readExact(size);
        }

        if (available > 0) {
            const result = this.$buffer.subarray(this.$bufferStart, this.$bufferEnd).slice();
            this.$bufferStart = this.$bufferEnd;
            return result;
        }

        // 尝试读取一次
        const n = await this.fill();
        if (! n) return null;

        const result = this.$buffer.subarray(0, this.$bufferEnd).slice();
        this.$bufferStart = this.$bufferEnd;
        return result;
    }

    /**
     * 读取直到遇到指定的分隔符
     * @param delimiter - 分隔符（字节数组）
     * @param maxLength - 最大长度限制
     * @returns 读取的数据（不包含分隔符），如果 EOF 则返回 null
     */
    async readUntil(delimiter: Uint8Array, maxLength: number = 65536): Promise<Uint8Array | null> {
        if (delimiter.length === 0) {
            throw new Error('Delimiter cannot be empty');
        }

        const chunks: Uint8Array[] = [];
        let totalLength = 0;

        while (true) {
            // 在当前缓冲区中查找分隔符
            let delimiterIndex = -1;
            for (let i = this.$bufferStart; i <= this.$bufferEnd - delimiter.length; i++) {
                let match = true;
                for (let j = 0; j < delimiter.length; j++) {
                    if (this.$buffer[i + j] !== delimiter[j]) {
                        match = false;
                        break;
                    }
                }
                if (match) {
                    delimiterIndex = i;
                    break;
                }
            }

            if (delimiterIndex !== -1) {
                // 找到分隔符
                const data = this.$buffer.subarray(this.$bufferStart, delimiterIndex);
                chunks.push(data.slice());
                totalLength += data.length;
                this.$bufferStart = delimiterIndex + delimiter.length;

                // 合并所有块
                if (chunks.length === 1) {
                    return chunks[0];
                } else {
                    const combined = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of chunks) {
                        combined.set(chunk, offset);
                        offset += chunk.length;
                    }
                    return combined;
                }
            }

            // 保存当前缓冲区的数据（保留可能的部分匹配）
            const available = this.$bufferEnd - this.$bufferStart;
            if (available >= delimiter.length) {
                const toSave = available - delimiter.length + 1;
                chunks.push(this.$buffer.subarray(this.$bufferStart, this.$bufferStart + toSave).slice());
                totalLength += toSave;
                this.$bufferStart += toSave;
            }

            // 检查长度限制
            if (totalLength >= maxLength) {
                throw new Error(`Data exceeds maximum length of ${maxLength} bytes`);
            }

            // 读取更多数据
            const n = await this.fill();
            if (n === null) {
                // EOF - 返回所有剩余数据
                if (this.$bufferEnd > this.$bufferStart) {
                    chunks.push(this.$buffer.subarray(this.$bufferStart, this.$bufferEnd).slice());
                    totalLength += this.$bufferEnd - this.$bufferStart;
                    this.$bufferStart = this.$bufferEnd;
                }
                
                if (totalLength === 0) {
                    return null;
                }
                
                const combined = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    combined.set(chunk, offset);
                    offset += chunk.length;
                }
                return combined;
            }
        }
    }

    /**
     * 窥视缓冲区中的数据（不消费）
     * @param size - 要窥视的字节数
     * @returns 窥视到的数据，如果数据不足则返回现有的
     */
    async peek(size: number): Promise<Uint8Array> {
        await this.ensureBytes(Math.min(size, this.$bufferSize));
        const available = Math.min(size, this.$bufferEnd - this.$bufferStart);
        return this.$buffer.subarray(this.$bufferStart, this.$bufferStart + available).slice();
    }

    /**
     * 跳过指定数量的字节
     * @param size - 要跳过的字节数
     * @returns 实际跳过的字节数
     */
    async skip(size: number): Promise<number> {
        let skipped = 0;
        while (skipped < size) {
            const available = this.$bufferEnd - this.$bufferStart;
            if (available > 0) {
                const toSkip = Math.min(available, size - skipped);
                this.$bufferStart += toSkip;
                skipped += toSkip;
            }

            if (skipped < size) {
                const n = await this.fill();
                if (n === null) {
                    break;
                }
            }
        }
        return skipped;
    }

    /**
     * 写入数据
     * @param data - 要写入的数据（字符串或字节数组）
     * @returns 写入的字节数
     */
    async write(data: string | Uint8Array): Promise<number> {
        if (this.$closed) {
            throw new Error('Pipe is closed');
        }
        const bytes = typeof data === 'string' ? this.$textEncoder.encode(data) : data;
        return await this.$conn.write(bytes);
    }

    /**
     * 写入一行数据（自动添加换行符）
     * @param line - 要写入的行
     * @returns 写入的字节数
     */
    async writeLine(line: string): Promise<number> {
        return await this.write(line + '\n');
    }

    /**
     * 获取缓冲区中未读取的字节数
     */
    get buffered(): number {
        return this.$bufferEnd - this.$bufferStart;
    }

    /**
     * 关闭管道
     */
    close(): void {
        if (!this.$closed) {
            this.$closed = true;
            this.$conn.close();
        }
    }

    /**
     * 关闭写入端
     */
    shutdown(): void {
        this.$conn.shutdown();
    }

    setOptions(option: Partial<{
        keepAlive: boolean;
        keepAliveDelay: number;
        noDelay: boolean;
    }>){
        if (option.keepAlive !== undefined) {
            this.$conn.setKeepAlive(option.keepAlive, option.keepAliveDelay ?? 0);
        }
        if (option.noDelay !== undefined) {
            this.$conn.setNoDelay(option.noDelay);
        }
    }

    /**
     * 获取本地地址
     */
    get localAddress(): Address {
        return this.$conn.localAddress;
    }

    /**
     * 获取远程地址
     */
    get remoteAddress(): Address {
        return this.$conn.remoteAddress;
    }

    /**
     * 获取底层连接
     */
    get connection(): Connection {
        return this.$conn;
    }

    /**
     * 检查管道是否已关闭
     */
    get ended(): boolean {
        return this.$closed;
    }
}