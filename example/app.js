/**
 * naci proj example task
 * @name naci
 * @version 1.0
 * @description naci demo
 * @author iz
 * @argument city 绍兴
 * @argument province 浙江
 */

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
        const weatherAPI = `https://cn.apihz.cn/api/tianqi/tqyb.php?id=88888888&key=88888888&sheng=${this.#env.province}&place=${this.#env.city}`;
        this.#console.log(`请求: ${weatherAPI}`);
        const fe = await this.#wrap(fetch(weatherAPI));
        const res = await this.#wrap(fe.json());
        this.#console.log(`浙江 绍兴 
<img src="${res.weather1img}" alt="%s" />
天气：${res.weather1}，温度：${res.nowinfo.temperature}℃，湿度：${res.nowinfo.humidity}%
气压：${res.nowinfo.pressure}hPa，风向：${res.nowinfo.windDirection}，风速：${res.nowinfo.windSpeed}km/h
仅供参考`, res.alarm);
    }

    async run(){
        while(true){
            await this.main();
            await this.#wrap(new Promise(resolve => setTimeout(resolve, 10 * 1000)));
        }
    };
    async stop(){
        this.#console.log('Naci Project Stopped!');
    }
}