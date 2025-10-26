await tjs.spawn([
    ... (tjs.system.platform == 'windows' ? ['cmd', '/c'] : ['sh']),
    tjs.args[0] == 'dev' 
        ? 'esbuild main.ts --bundle --external:tjs:* --external:tjs --target=es2024 --format=esm --outfile=dist.js'
        : 'esbuild main.ts --bundle --external:tjs:* --external:tjs --target=es2024 --format=esm --outfile=dist.js --minify'
], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit'
}).wait()

// add first line
const f = await tjs.readFile('dist.js');
const s = new TextDecoder().decode(f).trim();
if(!s.startsWith('#!')){
    const fh = await tjs.open('dist.js', 'w');
    await fh.write(new TextEncoder().encode(`#!/usr/bin/env tjs run\n${s}`));
    await fh.close();
}

export { }