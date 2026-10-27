'use strict';
// Read-only account/capability smoke; credentials are read exclusively from the environment.
const {createSandbox}=require('../src/execution/upstoxSandbox');
(async()=>{
 const broker=createSandbox({token:process.env.EDGE_UPSTOX_SANDBOX_TOKEN});
 const [orders,positions]=await Promise.all([broker.getOrders(),broker.getPositions()]);
 console.log(JSON.stringify({mode:'SANDBOX',authenticated:true,orderReadAvailable:true,positionReadAvailable:true,orders:orders.length,positions:positions.length,liveOrderRequests:0}));
})().catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'SANDBOX_CONNECTION_UNAVAILABLE');process.exitCode=1;});
