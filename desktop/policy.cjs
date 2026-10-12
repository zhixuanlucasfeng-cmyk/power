function webURL(value) {
 const url=new URL(value);
 if(!['https:','http:'].includes(url.protocol))throw new Error('Only HTTP and HTTPS pages are supported');
 if(url.username || url.password)throw new Error('Credentials in URLs are not supported');
 return url.href;
}
function bounds(rect,size){
 if(!rect || !['x','y','width','height'].every(k=>Number.isFinite(rect[k])))throw new Error('Invalid browser bounds');
 const x=Math.max(0,Math.min(size[0],Math.round(rect.x))),y=Math.max(0,Math.min(size[1],Math.round(rect.y)));
 return {x,y,width:Math.max(0,Math.min(size[0]-x,Math.round(rect.width))),height:Math.max(0,Math.min(size[1]-y,Math.round(rect.height)))};
}
module.exports={webURL,bounds};
