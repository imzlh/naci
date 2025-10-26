export default class NaciDemo {
    #wrap;
    #console;
    #env
    /**
     * @param {import("../src/core/app").AppInitArgs} self 
     */
    constructor(self) {
        this.#wrap = self.wrapper
        this.#console = self.console;
        this.#env = self.self;
    }

    async init(){
        this.#console.log('Naci Project!');
    }

    async main(){
        this.#console.log('时间:', new Date().toLocaleString())
    }

    async run(){
        // @ts-ignore
        const interval = parseInt(this.#env.interval) || 5000;
        while(true){
            await this.main();
            await this.#wrap(new Promise(resolve => setTimeout(resolve, interval)));
        }
    };
    async stop(){
        this.#console.log('Naci Project Stopped!');
    }
}