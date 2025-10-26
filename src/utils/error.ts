export function getError(e: any){
    return e instanceof Error? e.message : String(e);
}

export function trace(log: string){
    const error = new Error(log);
    console.error(error.message, '\n', error.stack);
}