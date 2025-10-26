import path from "tjs:path";

export async function writeTextFile(file: string, text: string) {
    const fHandle = await tjs.open(file, 'w');
    console.log(file);
    await fHandle.write(new TextEncoder().encode(text));
    await fHandle.close();
}

export async function ensure(file: string) {
    const dirname = path.dirname(file);
    await tjs.makeDir(dirname, { recursive: true });

    // touch file
    const fHandle = await tjs.open(file, 'a+');
    await fHandle.close();
}

export async function ensureDir(dir: string) {
    await tjs.makeDir(dir, { recursive: true });
}

export async function exists(fpath: string) {
    try{
        await tjs.stat(fpath);
        return true;
    } catch {
        return false;
    }
}