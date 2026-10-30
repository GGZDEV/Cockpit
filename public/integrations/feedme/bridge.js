(function () {
  const realFetch=window.fetch.bind(window), RealEvents=window.EventSource;
  const apiUrl=input=>{ const u=new URL(typeof input==='string'?input:input.url,location.href);return u.origin===location.origin && u.pathname.startsWith('/api/') ? u : null; };
  const shared=()=>window.parent!==window && typeof window.parent.MetaBoardFeedMeFetch==='function';
  window.fetch=(input,options)=>{const url=apiUrl(input);if (!url) return realFetch(input,options);return shared()?window.parent.MetaBoardFeedMeFetch(url.pathname+url.search,options):realFetch('/api/feedme/'+url.pathname.slice(5)+url.search,options);};
  class AuthenticatedEvents extends EventTarget {
    constructor(input) { super();this.url=input;this.readyState=0;this.closed=false;this.open(); }
    async open() {
      if (this.closed) return;this.controller=new AbortController();this.readyState=0;
      try {
        const response=await window.fetch(this.url,{signal:this.controller.signal,headers:{Accept:'text/event-stream'}});if (!response.ok || !response.body) throw Error('Connexion indisponible');
        this.readyState=1;this.dispatchEvent(new Event('open'));
        const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
        const emit=block=>{let name='message',data=[];for (const line of block.split('\n')) {if (line.startsWith('event:')) name=line.slice(6).trim();if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /,''));}if (data.length) this.dispatchEvent(new MessageEvent(name,{data:data.join('\n')}));};
        while (!this.closed) {const {value,done}=await reader.read();buffer+=decoder.decode(value,{stream:!done});buffer=buffer.replace(/\r\n/g,'\n');let at;while ((at=buffer.indexOf('\n\n'))>=0) {emit(buffer.slice(0,at));buffer=buffer.slice(at+2);}if (done) break;}
      } catch {if (!this.closed) this.dispatchEvent(new Event('error'));}
      if (!this.closed) {this.readyState=0;this.timer=setTimeout(()=>this.open(),3000);}
    }
    close() {this.closed=true;this.readyState=2;clearTimeout(this.timer);this.controller?.abort();}
  }
  Object.assign(AuthenticatedEvents,{CONNECTING:0,OPEN:1,CLOSED:2});
  window.EventSource=class {constructor(input,options) {if (shared() && apiUrl(input)) return new AuthenticatedEvents(input);const url=apiUrl(input);return new RealEvents(url?'/api/feedme/'+url.pathname.slice(5)+url.search:input,options);}};
})();
