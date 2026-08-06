// highlight.js/lib/common 的 exports 未提供 types 条件,
// 在 moduleResolution:"Bundler" + strict 下需要这份 ambient 声明复用主入口类型。
declare module 'highlight.js/lib/common' {
  import hljs from 'highlight.js'
  export default hljs
}
