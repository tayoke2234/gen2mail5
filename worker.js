/**
 * DEFINITIVE TEST SCRIPT
 * This script does only one thing: It checks for the KV and BOT_TOKEN.
 * If anything is missing, it will throw an error that we can see in the Cloudflare Logs.
 */ 
export default {
  async fetch(request, env) {
    // Test 1: Check if KV Binding exists.
    // If this fails, the error will appear in the logs.
    if (!env.MAIL_BOT_DB) {
      throw new Error("FATAL: KV Namespace 'MAIL_BOT_DB' is not bound. Please check Settings -> Bindings in your Cloudflare dashboard.");
    }

    // Test 2: Check if BOT_TOKEN environment variable exists.
    // If this fails, the error will appear in the logs.
    if (!env.BOT_TOKEN) {
      throw new Error("FATAL: Environment variable 'BOT_TOKEN' is not set. Please check Settings -> Variables in your Cloudflare dashboard.");
    }
    
    // If both tests pass, we send a success message to Telegram.
    if (request.method === "POST") {
        const payload = await request.json();
        const chatId = payload.message?.chat.id;
        if (chatId) {
            const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
            const body = {
                chat_id: chatId,
                text: "✅ SUCCESS! All settings are correct. You can now put the main script back.",
            };
            await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        }
    }

    return new Response("OK");
  },
};
