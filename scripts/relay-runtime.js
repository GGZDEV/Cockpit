'use strict';
const os=require('node:os'),fs=require('node:fs'),path=require('node:path');
function runtime() {
  const config=require('../deploy/config.json'),haOrigin=new URL(config.url).origin,host=new URL(haOrigin).hostname,prefix=host.split('.').slice(0,3).join('.')+'.';
  const addresses=Object.values(os.networkInterfaces()).flat().filter(item=>item.family==='IPv4' && !item.internal);
  const address=addresses.find(item=>item.address.startsWith(prefix))?.address;
  const saved=JSON.parse(fs.readFileSync(path.join(__dirname,'..','public','runtime.json'),'utf8'));
  return {...(saved.agentsOrigin ? {agentsOrigin:saved.agentsOrigin} : {}),haOrigin,pcOrigin:address?'http://'+address+':3889':null};
}
function writeRuntime() {
  const value=runtime(),file=path.join(__dirname,'..','public','runtime.json'),json=JSON.stringify(value);
  if (!fs.existsSync(file) || fs.readFileSync(file,'utf8')!==json) fs.writeFileSync(file,json);
  return value;
}
module.exports={runtime,writeRuntime};
