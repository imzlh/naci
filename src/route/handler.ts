import HTTPClient, { Protocol, ReadState } from "../http/client";
import Pipe from "../http/pipe";
import Router from "../http/router";
import assert from "../utils/assert";

export default class HandlerClass extends HTTPClient{
    static router: Router;

    constructor(pipe: Pipe){
        super(pipe, HTTPClient.ROLE_SERVER);
        this.handle().catch(e => console.error(e));
    }

    private async handle(): Promise<void> {
        // if(!HandlerClass.router){
        //     return this.writeResponse(500, "Internal Server Error", {}, "No Endpoint to handle request");
        // }

        this.on('response', res => console.log(this.request?.method, this.request?.url, res.code))

        const $r = HandlerClass.router;
        let looped = 0;
        while(!this.$pipe.ended) 
            try{
                if(looped ++ > 16){
                    this.close();
                    break;
                }
                await $r.handle(this);
                if(this.state == ReadState.ERROR || this.protocol != Protocol.HTTP) break;
                if(this.state == ReadState.BODY) this.readBody();
                this.reuse();
            }catch(e){
                if(e instanceof Error && e.message.includes('closed')) break;
                console.error('Failed to handle request', e);
            }
        // this.writeResponse(200, "OK", {}, "Hello World");
    }
}