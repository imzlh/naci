import Router from "../http/router";

export default function initStatic(router: Router, root: string){
    router.get('/', ctx => ctx.redirect('/index.html'));
    router.static("/", root, {
        index: "index.html",
        dotfiles: 'deny',
        etag: true,
        maxage: 0
    })
}