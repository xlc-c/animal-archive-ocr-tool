declare module '*?worker&inline' {
  const workerConstructor: new () => Worker
  export default workerConstructor
}
declare module '*?raw' {
  const content: string
  export default content
}
declare module '*?b64' {
  const base64: string
  export default base64
}
