/**
 * FINAL DEBUGGING SCRIPT
 * This version includes a try...catch block to send any errors directly to you in Telegram.
 * This will tell us exactly what is failing.
 */

// --- Main Handler ---
export default {
  async fetch(request, env) {
    // We wrap the main logic in a try...catch block
    try {
      if (request.method === "POST") {
        const payload = await request.json();
        if (payload.message) {
          await handleMessage(payload.message, env);
        } else if (payload.callback_query) {
          await handleCallbackQuery(payload.callback_query, env);
        }
      }
    } catch (e) {
      // If any error happens, it will be caught here.
      // We try to find a chat_id to send the error message to.
      let chatId;
      try {
        const payload = await request.json();
        chatId = payload.message?.chat.id || payload.callback_query?.message?.chat.id;
      } catch (jsonError) {
        // Ignore if we can't even parse the JSON
      }
      
      if (chatId) {
        // Send the error message directly to the user in Telegram
        await sendError(chatId, e, env);
      }
    }
    return new Response("OK");
  },

  async email(message, env) {
    try {
      const to = message.to.toLowerCase();
      const emailKey = `email:${to}`;
      const emailData = await env.MAIL_BOT_DB.get(emailKey);
      if (!emailData) {
        message.setReject("Address does not exist.");
        return;
      }
      const reader = message.raw.getReader();
      let chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const rawEmail = new TextDecoder("utf-8").decode(new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], [])));
      const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
      const body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";
      const newEmail = {
        from: message.headers.get("from") || "Unknown Sender",
        subject: message.headers.get("subject") || "No Subject",
        body: body,
        receivedAt: new Date().toISOString(),
      };
      let { inbox, owner } = JSON.parse(emailData);
      inbox.unshift(newEmail);
      await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));
      await sendMessage(owner, `📬 **လိပ်စာအသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။`, null, env);
    } catch (e) {
      console.error("Email processing failed:", e);
    }
  },
};

// --- Error Handler ---
async function sendError(chatId, error, env) {
    const errorMessage = `⛔ **An Error Occurred!**

**Message:**
${error.message}

**Stack:**
\`\`\`
${error.stack}
\`\`\`

Please check your Worker's KV Binding ('MAIL_BOT_DB') in the Cloudflare Dashboard.`;
    await sendMessage(chatId, errorMessage, null, env);
}

// --- Original Code (handleMessage, etc.) starts here ---

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text ? message.text.toLowerCase() : "";
  const userKey = `user:${chatId}`;
  
  await trackUserActivity(userKey, env);
  
  if (message.reply_to_message && message.reply_to_message.text.includes("သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ")) {
      await createNewEmail(chatId, text.split(" ")[0], env);
      return;
  }

  switch (text) {
    case "/start":
      await handleStart(chatId, env);
      break;
    case "/create":
      await requestEmailName(chatId, env);
      break;
    case "/my_emails":
      await listUserEmails(chatId, env);
      break;
    case "/random_address":
      await generateRandomAddress(chatId, env);
      break;
    case "/panel":
      await showUserPanel(chatId, env);
      break;
    case "/admin":
      if (env.ADMIN_IDS && env.ADMIN_IDS.split(",").includes(chatId.toString())) {
        await showAdminPanel(chatId, env);
      } else {
        await sendMessage(chatId, "⛔ သင်သည် Admin မဟုတ်ပါ။", null, env);
      }
      break;
    default:
      await handleStart(chatId, env);
  }
}

// All other functions (sendMessage, editMessage, listUserEmails, etc.) remain the same as the original script.
// They are included here for completeness.

async function sendMessage(chatId, text, reply_markup = null, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
  if (reply_markup) { payload.reply_markup = reply_markup; }
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function editMessage(chatId, messageId, text, reply_markup = null, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" };
  if (reply_markup) { payload.reply_markup = reply_markup; }
  await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
}

async function sendDocument(chatId, content, filename, caption, reply_markup, env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([content], { type: 'text/plain' }), filename);
    formData.append('caption', caption);
    formData.append('parse_mode', 'Markdown');
    if (reply_markup) { formData.append('reply_markup', JSON.stringify(reply_markup)); }
    await fetch(url, { method: 'POST', body: formData });
}

async function handleStart(chatId, env) {
  const text = `👋 **မင်္ဂလာပါ၊ Temp Mail Bot မှ ကြိုဆိုပါတယ်။**\n\n**အဓိက Commands များ:**\n/create, /my_emails, /random_address, /panel\nAdmin များအတွက်: /admin`;
  await sendMessage(chatId, text, null, env);
}

async function requestEmailName(chatId, env) {
    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**\n\nသင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ။\n\nBot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    const replyMarkup = { force_reply: true, selective: true, input_field_placeholder: 'your-name-here' };
    await sendMessage(chatId, text, replyMarkup);
}

async function createNewEmail(chatId, name, env) {
  if (!/^[a-z0-9.-]+$/.test(name)) {
    await sendMessage(chatId, "❌ **မှားယွင်းနေပါသည်!**\nနာမည်တွင် English အက္ခရာ အသေး (a-z)၊ ဂဏန်း (0-9)၊ နှင့် `.` `-` တို့သာ ပါဝင်ရပါမည်။", null, env);
    return;
  }
  const email = `${name.toLowerCase()}@${env.DOMAIN}`;
  const emailKey = `email:${email}`;
  const userKey = `user:${chatId}`;
  const existingEmail = await env.MAIL_BOT_DB.get(emailKey);
  if (existingEmail) {
    await sendMessage(chatId, `😥 **လိပ်စာအသုံးပြုပြီးသားပါ။**`, null, env);
    return;
  }
  await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox: [], owner: chatId }));
  let userData = await env.MAIL_BOT_DB.get(userKey);
  userData = userData ? JSON.parse(userData) : { createdEmails: [], lastActive: new Date().toISOString() };
  userData.createdEmails.push(email);
  await env.MAIL_BOT_DB.put(userKey, JSON.stringify(userData));
  await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\``, null, env);
}

async function listUserEmails(chatId, env) {
  const userKey = `user:${chatId}`;
  const userData = await env.MAIL_BOT_DB.get(userKey);
  if (!userData || JSON.parse(userData).createdEmails.length === 0) {
    await sendMessage(chatId, "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။", null, env);
    return;
  }
  const { createdEmails } = JSON.parse(userData);
  const keyboard = createdEmails.map(email => ([
    { text: `📥 Inbox: ${email}`, callback_data: `view_inbox:${email}` },
    { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email:${email}` },
  ]));
  await sendMessage(chatId, "သင်၏ Email လိပ်စာများ:", { inline_keyboard: keyboard }, env);
}

async function showUserPanel(chatId, env) {
    const userKey = `user:${chatId}`;
    const userData = await env.MAIL_BOT_DB.get(userKey);
    const emailCount = userData ? JSON.parse(userData).createdEmails.length : 0;
    const text = `👤 **User Control Panel**\n\n- သင်၏ Telegram ID: \`${chatId}\`\n- ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\``;
    const keyboard = { inline_keyboard: [
        [{ text: "📧 Email များကြည့်ရန်", callback_data: "panel_my_emails" }],
        [{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "panel_create" }],
        [{ text: "🎲 ကျပန်းလိပ်စာ", callback_data: "panel_random" }],
    ]};
    await sendMessage(chatId, text, keyboard, env);
}

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const [action, ...params] = data.split(":");
  await trackUserActivity(`user:${chatId}`, env);
  switch (action) {
    case "view_inbox": await viewInbox(chatId, params[0], env); break;
    case "refresh_inbox": await viewInbox(chatId, params[0], env, messageId); break;
    case "delete_email": await confirmDeleteEmail(chatId, messageId, params[0], env); break;
    case "delete_confirm": await deleteEmail(chatId, messageId, params[0], env); break;
    case "delete_cancel": await editMessage(chatId, messageId, "ဖျက်ခြင်းကို ပယ်ဖျက်လိုက်ပါသည်။", null, env); break;
    case "create_random": await createNewEmail(chatId, params[0], env); await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, null, env); break;
    case "generate_another": await generateRandomAddress(chatId, env, messageId); break;
    case "panel_my_emails": await listUserEmails(chatId, env); break;
    case "panel_create": await requestEmailName(chatId, env); break;
    case "panel_random": await generateRandomAddress(chatId, env); break;
    case "admin_stats": await showAdminStats(chatId, messageId, env); break;
    case "admin_list_users": await listAllUsers(chatId, messageId, parseInt(params[0] || 1), env); break;
    case "admin_view_user": await viewUserEmailsAsAdmin(chatId, messageId, params[0], parseInt(params[1] || 1), env); break;
    case "admin_delete_email": await deleteEmailAsAdmin(chatId, messageId, params[0], params[1], env); break;
    case "admin_storage": await showStorageUsage(chatId, messageId, env); break;
    case "admin_inactive_users": await listInactiveUsers(chatId, messageId, parseInt(params[0] || 30), env); break;
    case "admin_back": await showAdminPanel(chatId, env, messageId); break;
  }
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callbackQuery.id}`);
}

async function viewInbox(chatId, email, env, messageId = null) {
  const emailKey = `email:${email}`;
  const emailData = await env.MAIL_BOT_DB.get(emailKey);
  if (!emailData) { await sendMessage(chatId, "❌ Error: Email not found.", null, env); return; }
  const { inbox } = JSON.parse(emailData);
  if (inbox.length === 0) {
    const text = `**Inbox: \`${email}\`**\n\n텅နေပါသည်!`;
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }]] };
    if (messageId) { await editMessage(chatId, messageId, text, keyboard, env); } else { await sendMessage(chatId, text, keyboard, env); }
    return;
  }
  let fileContent = `Inbox for: ${email}\n=========================\n\n`;
  inbox.forEach(mail => { fileContent += `From: ${mail.from}\nSubject: ${mail.subject}\nDate: ${new Date(mail.receivedAt).toLocaleString('en-GB')}\n-------------------------\n${mail.body}\n\n=========================\n\n`; });
  const caption = `📥 **Inbox for \`${email}\`**\n\nစုစုပေါင်း email \`${inbox.length}\` စောင်ရှိပါသည်။`;
  const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }]] };
  await sendDocument(chatId, fileContent, `inbox_${email}.txt`, caption, keyboard, env);
}

async function confirmDeleteEmail(chatId, messageId, email, env) {
  const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` ကို အပြီးတိုင် ဖျက်လိုပါသလား?`;
  const keyboard = { inline_keyboard: [[{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_confirm:${email}` }, { text: "❌ မဟုတ်ပါ", callback_data: "delete_cancel" }]] };
  await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteEmail(chatId, messageId, email, env) {
  const userKey = `user:${chatId}`;
  const emailKey = `email:${email}`;
  let userData = await env.MAIL_BOT_DB.get(userKey);
  if (userData) {
    let parsedData = JSON.parse(userData);
    parsedData.createdEmails = parsedData.createdEmails.filter(e => e !== email);
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
  }
  await env.MAIL_BOT_DB.delete(emailKey);
  await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**`, null, env);
}

async function generateRandomAddress(chatId, env, messageId = null) {
    const cities = ["yangon", "mandalay", "naypyitaw", "bago", "mawlamyine"];
    const nouns = ["post", "mail", "box", "connect", "link", "service"];
    const randomName = `${cities[Math.floor(Math.random() * cities.length)]}.${nouns[Math.floor(Math.random() * nouns.length)]}${Math.floor(100 + Math.random() * 900)}`;
    const text = `🎲 **ကျပန်းလိပ်စာ**\n\nအကြံပြုထားသော လိပ်စာမှာ:\n\`${randomName}@${env.DOMAIN}\`\n\nသင်ဤလိပ်စာကို အသုံးပြုလိုပါသလား?`;
    const keyboard = { inline_keyboard: [[{ text: "✅ ဒီလိပ်စာကို ဖန်တီးမည်", callback_data: `create_random:${randomName}` }], [{ text: "🎲 နောက်တစ်ခု", callback_data: "generate_another" }]] };
    if (messageId) { await editMessage(chatId, messageId, text, keyboard, env); } else { await sendMessage(chatId, text, keyboard, env); }
}

async function showAdminPanel(chatId, env, messageId = null) {
  const text = `⚙️ **Admin Control Panel**`;
  const keyboard = { inline_keyboard: [
      [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
      [{ text: "👥 Users List", callback_data: "admin_list_users:1" }],
      [{ text: "💾 Storage Usage", callback_data: "admin_storage" }],
      [{ text: "⏳ Inactive Users", callback_data: "admin_inactive_users:30" }],
  ]};
  if (messageId) { await editMessage(chatId, messageId, text, keyboard, env); } else { await sendMessage(chatId, text, keyboard, env); }
}

async function showAdminStats(chatId, messageId, env) {
  const allUserKeys = await env.MAIL_BOT_DB.list({ prefix: "user:" });
  const allEmailKeys = await env.MAIL_BOT_DB.list({ prefix: "email:" });
  const text = `📊 **Bot Statistics**\n\n- စုစုပေါင်း User: \`${allUserKeys.keys.length}\`\n- စုစုပေါင်း Email: \`${allEmailKeys.keys.length}\``;
  const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin_back" }]] };
  await editMessage(chatId, messageId, text, keyboard, env);
}

async function listAllUsers(chatId, messageId, page, env) {
  const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
  const usersPerPage = 5;
  const totalPages = Math.ceil(allUserKeys.length / usersPerPage);
  page = Math.max(1, Math.min(page, totalPages));
  const start = (page - 1) * usersPerPage;
  const userPageKeys = allUserKeys.slice(start, end);
  let text = `👥 **Users List (Page ${page}/${totalPages})**\n\n`;
  const keyboardRows = userPageKeys.map(key => ([{ text: `👤 ${key.name.split(":")[1]}`, callback_data: `admin_view_user:${key.name.split(":")[1]}:1` }]));
  const paginationRow = [];
  if (page > 1) { paginationRow.push({ text: "◀️ Prev", callback_data: `admin_list_users:${page - 1}` }); }
  if (page < totalPages) { paginationRow.push({ text: "Next ▶️", callback_data: `admin_list_users:${page + 1}` }); }
  if (paginationRow.length > 0) { keyboardRows.push(paginationRow); }
  keyboardRows.push([{ text: "⬅️ Back", callback_data: "admin_back" }]);
  await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function viewUserEmailsAsAdmin(chatId, messageId, targetUserId, page, env) {
  const userData = await env.MAIL_BOT_DB.get(`user:${targetUserId}`);
  if (!userData || JSON.parse(userData).createdEmails.length === 0) {
    await editMessage(chatId, messageId, `User \`${targetUserId}\` has no emails.`, { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin_list_users:1" }]] }, env);
    return;
  }
  const { createdEmails } = JSON.parse(userData);
  let text = `📧 **Emails for User: \`${targetUserId}\`**\n\n`;
  const keyboardRows = createdEmails.map(email => ([
    { text: `📥 ${email}`, callback_data: `view_inbox:${email}` },
    { text: "🗑️ Delete", callback_data: `admin_delete_email:${email}:${targetUserId}` }
  ]));
  keyboardRows.push([{ text: "⬅️ Back", callback_data: "admin_list_users:1" }]);
  await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function deleteEmailAsAdmin(chatId, messageId, emailToDelete, targetUserId, env) {
    const userKey = `user:${targetUserId}`;
    const emailKey = `email:${emailToDelete}`;
    let userData = await env.MAIL_BOT_DB.get(userKey);
    if (userData) {
        let parsedData = JSON.parse(userData);
        parsedData.createdEmails = parsedData.createdEmails.filter(e => e !== emailToDelete);
        await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
    }
    await env.MAIL_BOT_DB.delete(emailKey);
    await editMessage(chatId, messageId, `✅ **Deleted!**`, { inline_keyboard: [[{ text: "⬅️ View User's Emails", callback_data: `admin_view_user:${targetUserId}:1` }]] }, env);
}

async function showStorageUsage(chatId, messageId, env) {
    const allKeys = await env.MAIL_BOT_DB.list();
    const text = `💾 **KV Storage Usage (Estimate)**\n\n- Total Keys: \`${allKeys.keys.length}\``;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin_back" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function listInactiveUsers(chatId, messageId, days, env) {
    const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
    const inactiveUsers = [];
    const threshold = new Date();
    threshold.setDate(threshold.getDate() - days);
    for (const key of allUserKeys) {
        const userData = await env.MAIL_BOT_DB.get(key.name);
        if (userData) {
            const { lastActive } = JSON.parse(userData);
            if (!lastActive || new Date(lastActive) < threshold) {
                inactiveUsers.push(key.name.split(":")[1]);
            }
        }
    }
    let text = `⏳ **Inactive Users (Last active > ${days} days ago)**\n\n`;
    text += inactiveUsers.length === 0 ? "No inactive users." : inactiveUsers.map(id => `- \`${id}\``).join("\n");
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Back", callback_data: "admin_back" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function trackUserActivity(userKey, env) {
    let userData = await env.MAIL_BOT_DB.get(userKey);
    let parsedData = userData ? JSON.parse(userData) : { createdEmails: [] };
    parsedData.lastActive = new Date().toISOString();
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
}
