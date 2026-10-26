'use strict';

const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createTelegramTransport}=require('./telegramTransport');
const token='123456:FAKE_TEST_TOKEN_NOT_REAL_1234567890';

function mock(plan) {
  const captured={};
  const request=(options,callback)=>{
    captured.options=options;
    const req=new EventEmitter();
    req.setTimeout=(ms,handler)=>{captured.timeout=ms;captured.onTimeout=handler;};
    req.destroy=()=>queueMicrotask(()=>req.emit('error',new Error('raw URL /bot'+token+' must not escape')));
    req.end=body=>{
      captured.body=JSON.parse(body);
      queueMicrotask(()=>{
        if(plan==='timeout'){captured.onTimeout();return;}
        const response=new EventEmitter();response.statusCode=plan.status||200;
        callback(response);
        if(plan==='aborted'){response.emit('aborted');response.emit('close');return;}
        response.emit('data',Buffer.from(typeof plan.body==='string'?plan.body:JSON.stringify(plan.body)));
        response.emit('end');response.emit('close');
      });
    };
    return req;
  };
  return {api:createTelegramTransport(token,request),captured};
}

(async()=>{
  const ok=mock({body:{ok:true,result:{message_id:1}}});
  assert.deepEqual(await ok.api('sendMessage',{chat_id:'123456789',text:'fixture'}),{message_id:1});
  assert.equal(ok.captured.options.hostname,'api.telegram.org');
  assert.equal(ok.captured.options.port,443);assert.equal(ok.captured.options.method,'POST');
  assert.equal(ok.captured.timeout,7000);assert.equal(ok.captured.body.chat_id,'123456789');
  await assert.rejects(()=>ok.api('getUpdates',{}),error=>error.code==='UNSUPPORTED_METHOD');
  const limited=mock({status:429,body:{ok:false,error_code:429,parameters:{retry_after:7}}});
  await assert.rejects(()=>limited.api('sendMessage',{}),error=>error.code==='TELEGRAM_RATE_LIMIT'&&error.retryAfterMs===7000&&!error.ambiguous);
  const blocked=mock({status:403,body:{ok:false,error_code:403,description:token}});
  await assert.rejects(()=>blocked.api('sendMessage',{}),error=>error.permanent&&!error.message.includes(token));
  for(const plan of ['timeout','aborted',{status:502,body:'not JSON'},{status:200,body:'null'},
    {status:200,body:'[]'},{status:302,body:{ok:false}}]) {
    const failed=mock(plan);
    await assert.rejects(()=>failed.api('sendMessage',{}),error=>error.ambiguous&&!error.message.includes(token));
  }
  const readTimeout=mock('timeout');
  await assert.rejects(()=>readTimeout.api('getChat',{}),error=>!error.ambiguous);
  console.log('Telegram transport PASS: fixed HTTPS destination, bounded requests, sanitized errors, explicit rate limits, aborts and ambiguous-send classification');
})().catch(error=>{console.error(error);process.exitCode=1;});
