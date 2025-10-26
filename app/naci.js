export class NaciDemo {
    #wrap;
    #console;
    /**
     * @param {import("../src/core/app").AppPromiseWrapper} $wrap 
     * @param {import("../src/core/console").IConsole} $console 
     */
    constructor($wrap, $console) {
        this.#wrap = $wrap
        this.#console = $console;
    }

    async init(){
        this.#console.log('Naci Project!');
    }

    async main(){
        const weatherAPI = 'https://cn.apihz.cn/api/tianqi/tqyb.php?id=88888888&key=88888888&sheng=浙江&place=绍兴';
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