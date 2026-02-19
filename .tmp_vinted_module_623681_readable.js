623681,e=>{"use strict";;
var t=e.i(786830),i=e.i(934267),r=e.i(294111),o=e.i(499555),n=e.i(491287),s=e.i(807999);;
let a=async(e,r)=>{
let{id:o,type:a,enabledSessionStorageCache:l}=e,c=await t.api.post("/purchases/checkout/build",{purchase_items:[{id:Number(o),type:a}]},r);;
return"errors"in c||!l||(e=>{try{(0,i.setSessionStorageItem)(n.SINGLE_CHECKOUT_DATA_STORAGE_KEY,JSON.stringify(e))
}catch(e){(0,s.logError)(e,{feature:"checkout_data_set_session_storage"})
}})(c.checkout),c};;
e.s(["fetchInitialSingleCheckoutData",0,e=>{
let{id:a,args:l,enabledSessionStorageCache:c}=e;;
if(c){
let e=(()=>{try{return JSON.parse((0,i.getSessionStorageItem)(n.SINGLE_CHECKOUT_DATA_STORAGE_KEY)||"{}")
}catch(e){return(0,s.logError)(e,{feature:"checkout_data_get_session_storage"}),null}})();;
if((0,i.removeSessionStorageItem)(n.SINGLE_CHECKOUT_DATA_STORAGE_KEY),e&&0!==Object.keys(e).length&&a===e.id)return Promise.resolve({checkout:e,status:r.HttpStatus.Ok})
}return t.api.put(`/purchases/${a}/checkout`,l&&(0,o.updateSingleCheckoutDataArgsToParams)(l))
},
"initiateSingleCheckout",0,a,"refreshSingleCheckoutPurchase",0,e=>t.api.put(`/purchases/${e}/checkout`,{components:[]}),"updateSingleCheckoutData",0,(e,i)=>t.api.put(`/purchases/${e}/checkout`,i&&(0,o.updateSingleCheckoutDataArgsToParams)(i))],
623681)
}