// Local fixture only: node scripts/qa/stalled-provider-server.mjs /absolute/path/to/isolated/release
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
const { default: worker } = await import(pathToFileURL(process.argv[2] + '/worker/worker.js'));
let now = Date.parse('2026-09-10T19:20:00Z');
let mode = 'healthy';
Date.now = () => now;
globalThis.fetch = async (url, options) => {
  if (!String(url).startsWith('https://v3.football.api-sports.io/')) throw Error('Unexpected fixture request');
  if (mode === 'slow') return new Promise((resolve,reject) => options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  return Response.json({ errors:[], response:String(url).includes('/standings')?[]:[{
    fixture:{id:900002,date:'2026-09-10T19:00:00Z',status:{short:'1H',elapsed:20}},
    league:{id:2,season:2026,round:'League Stage - 1'},teams:{home:{id:1,name:'Home'},away:{id:2,name:'Away'}},
    goals:{home:mode==='recovered'?2:1,away:0},score:{fulltime:{home:null,away:null}}
  }] });
};
createServer(async(req,res)=>{
  if(req.url.startsWith('/mode/')){mode=req.url.split('/').at(-1);now+=61000;res.end(mode);return;}
  const started=performance.now();
  const result=await worker.fetch(new Request('https://test.invalid'+req.url),{API_FOOTBALL_KEY:'fixture-key',API_FOOTBALL_COMPETITIONS:'CL:2026'},{waitUntil(){}});
  res.writeHead(result.status,{'content-type':'application/json','x-fixture-duration-ms':String(Math.round(performance.now()-started))});
  res.end(await result.text());
}).listen(8733,'127.0.0.1',()=>console.log('Isolated Worker fixture ready on 8733'));
