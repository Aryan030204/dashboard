const { createKafkaPublisher } = require('/app/services/intent/kafkaProducer');
const logger = { info: (m) => /connected/.test(m) && console.log('I', m), warn: (m) => console.log('W', m), error: (m) => console.log('E', m) };
const pub = createKafkaPublisher({ config: { brokers: ['kafka-service:9092'], clientId: 'repro', sendTimeoutMs: 5000, maxInFlight: 50 }, logger, statsIntervalMs: 0 });
pub.start();
const t0 = Date.now(); let ok = 0, fail = 0, last = '';
const sec = () => ((Date.now() - t0) / 1000) | 0;
const tick = setInterval(async () => {
  try { await pub.publish({ topic: 'intent.other', key: 'repro:1', value: '{"repro":1}' }); ok++; } catch (e) { fail++; last = e.category; }
}, 200);
const rep = setInterval(() => { console.log(`+${sec()}s ok=${ok} fail=${fail} last=${last} connected=${pub.stats().connected} rebuilds=${pub.stats().rebuilds}`); ok = 0; fail = 0; }, 5000);
setTimeout(() => { clearInterval(tick); clearInterval(rep); process.exit(0); }, 150000);
