/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested fixes)
 * Language: Burmese (Comments) & English (Code)
 * Features: User panel, Admin panel, Email creation/deletion, Inbox viewer, Random address generator.
 * Database: Cloudflare KV
 * Email Receiving: Cloudflare Email Routing
 *
 * Fixes in this version:
 * - The /myemails command now works (aliases /my_emails).
 * - Email creation confirmation logic is clarified and works via 'reply'.
 */

// --- Configuration ---
// These values are set in the Worker's environment variables (Settings -> Variables)
// BOT_TOKEN: Your Telegram bot token
// ADMIN_IDS: Comma-separated list of admin Telegram user IDs
// DOMAIN: The domain you are using for emails

// --- Main Handler ---
export default {
  /**
   * Handles incoming HTTP requests from Telegram's webhook.
   * @param {Request} request - The incoming request object.
   * @param {object} env - The environment object containing secrets and KV bindings.
   * @returns {Response} - A response to acknowledge receipt.
   */
  async fetch(request, env) {
    if (request.method === "POST") {
      const payload = await request.json();
      if (payload.message) {
        await handleMessage(payload.message, env);
      } else if (payload.callback_query) {
        await handleCallbackQuery(payload.callback_query, env);
      }
    }
    return new Response("OK");
  },

  /**
   * Handles incoming emails via Cloudflare Email Routing.
   * @param {EmailMessage} message - The incoming email object.
   * @param {object} env - The environment object.
   */
  async email(message, env) {
    const to = message.to.toLowerCase();
    const emailKey = `email:${to}`;

    // Check if the email address was created by a user
    const emailData = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailData) {
      // If the address doesn't exist in our system, reject the email
      message.setReject("Address does not exist.");
      return;
    }

    // Read the email body stream
    const reader = message.raw.getReader();
    let chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const rawEmail = new TextDecoder("utf-8").decode(
      new Uint8Array(
        chunks.reduce((acc, chunk) => [...acc, ...chunk], [])
      )
    );

    // Parse the email body (simple parsing)
    const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
    const body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";

    const newEmail = {
      from: message.headers.get("from") || "Unknown Sender",
      subject: message.headers.get("subject") || "No Subject",
      body: body,
      receivedAt: new Date().toISOString(),
    };

    let { inbox, owner } = JSON.parse(emailData);
    inbox.unshift(newEmail); // Add new email to the top

    // Save the updated inbox
    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

    // Notify the user
    await sendMessage(
      owner,
      `📬 **လိပ်စာအသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\n/my_emails မှတစ်ဆင့် စစ်ဆေးနိုင်ပါသည်။`,
      null,
      env
    );
  },
};

// --- Telegram API Helper Functions ---

async function sendMessage(chatId, text, reply_markup = null, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown",
  };
  if (reply_markup) {
    payload.reply_markup = reply_markup;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function editMessage(chatId, messageId, text, reply_markup = null, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown",
  };
  if (reply_markup) {
    payload.reply_markup = reply_markup;
  }
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function sendDocument(chatId, content, filename, caption, reply_markup, env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`;
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([content], { type: 'text/plain' }), filename);
    formData.append('caption', caption);
    formData.append('parse_mode', 'Markdown');
    if (reply_markup) {
        formData.append('reply_markup', JSON.stringify(reply_markup));
    }
    await fetch(url, {
        method: 'POST',
        body: formData,
    });
}


// --- Message Handlers ---

async function handleMessage(message, env) {
  const chatId = message.chat.id;
  const text = message.text ? message.text.toLowerCase().trim() : "";
  const userKey = `user:${chatId}`;
  
  await trackUserActivity(userKey, env);
  
  // Handle reply for email creation
  if (message.reply_to_message && message.reply_to_message.text.includes("သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ")) {
      await createNewEmail(chatId, text.split(" ")[0], env);
      return;
  }

  // Command handling
  switch (text) {
    case "/start":
      await handleStart(chatId, env);
      break;
    case "/create":
      await requestEmailName(chatId, env);
      break;
    case "/my_emails": // Original command
    case "/myemails":   // Added alias for user convenience
      await listUserEmails(chatId, env);
      break;
    case "/random_address":
      await generateRandomAddress(chatId, env);
      break;
    case "/panel":
      await showUserPanel(chatId, env);
      break;
    case "/admin":
      if (env.ADMIN_IDS.split(",").includes(chatId.toString())) {
        await showAdminPanel(chatId, env);
      } else {
        await sendMessage(chatId, "⛔ သင်သည် Admin မဟုတ်ပါ။", null, env);
      }
      break;
    default:
      // If it's not a recognized command, show the start message
      await handleStart(chatId, env);
  }
}

async function handleStart(chatId, env) {
  const text = `👋 **မင်္ဂလာပါ၊ Temp Mail Bot မှ ကြိုဆိုပါတယ်။**

သင်၏ကိုယ်ပိုင်ယာယီအီးမေးလ်များကို ဤနေရာတွင် ဖန်တီးနိုင်၊ စီမံခန့်ခွဲနိုင်ပါသည်။

**အဓိက Commands များ:**
/create - Email လိပ်စာအသစ် ဖန်တီးရန်
/my_emails - သင်၏ Email များကို ကြည့်ရှုရန်
/random_address - ကျပန်းလိပ်စာတစ်ခု ဖန်တီးရန်
/panel - User Control Panel

Admin များအတွက်: /admin`;
  await sendMessage(chatId, text, null, env);
}

async function requestEmailName(chatId, env) {
    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**

သင်အသုံးပြုလိုသော နာမည်ကိုထည့်ပါ။ (Space မပါစေရ၊ English အက္ခရာနှင့် ဂဏန်းများသာ)။

**အရေးကြီး:** ဤ Message ကို **Reply** လုပ်ပြီး နာမည်ထည့်ပေးပါ။

ဥပမာ: \`myname123\`

Bot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    
    // Using force_reply to get user input
    const replyMarkup = {
        force_reply: true,
        selective: true,
        input_field_placeholder: 'your-name-here'
    };
    await sendMessage(chatId, text, replyMarkup, env);
}

async function createNewEmail(chatId, name, env) {
  if (!/^[a-z0-9.-]+$/.test(name)) {
    await sendMessage(chatId, "❌ **မှားယွင်းနေပါသည်!**\nနာမည်တွင် English အက္ခရာ အသေး (a-z)၊ ဂဏန်း (0-9)၊ နှင့် `.` `-` တို့သာ ပါဝင်ရပါမည်။ Space မပါရပါ။\n\n/create ကိုပြန်နှိပ်ပြီး ထပ်ကြိုးစားပါ။", null, env);
    return;
  }

  const email = `${name.toLowerCase()}@${env.DOMAIN}`;
  const emailKey = `email:${email}`;
  const userKey = `user:${chatId}`;

  const existingEmail = await env.MAIL_BOT_DB.get(emailKey);
  if (existingEmail) {
    await sendMessage(chatId, `😥 **လိပ်စာအသုံးပြုပြီးသားပါ။**\n\`${email}\` သည် အခြားသူတစ်ယောက် အသုံးပြုနေပါသည်။ နာမည်အသစ်တစ်ခု ထပ်ကြိုးစားပါ။`, null, env);
    return;
  }

  // Create email record
  await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox: [], owner: chatId }));

  // Add email to user's list
  let userData = await env.MAIL_BOT_DB.get(userKey);
  userData = userData ? JSON.parse(userData) : { createdEmails: [], lastActive: new Date().toISOString() };
  userData.createdEmails.push(email);
  await env.MAIL_BOT_DB.put(userKey, JSON.stringify(userData));

  // This is the confirmation message that will be sent upon successful creation
  await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\`\n\n/my_emails ကိုနှိပ်ပြီး စီမံခန့်ခွဲနိုင်ပါသည်။`, null, env);
}

async function listUserEmails(chatId, env) {
  const userKey = `user:${chatId}`;
  const userData = await env.MAIL_BOT_DB.get(userKey);

  if (!userData || JSON.parse(userData).createdEmails.length === 0) {
    await sendMessage(chatId, "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။\n/create ကိုနှိပ်ပြီး စတင်လိုက်ပါ။", null, env);
    return;
  }

  const { createdEmails } = JSON.parse(userData);
  const keyboard = [];
  for (const email of createdEmails) {
    keyboard.push([
      { text: `📥 Inbox: ${email}`, callback_data: `view_inbox:${email}` },
      { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email:${email}` },
    ]);
  }

  await sendMessage(chatId, "သင်၏ Email လိပ်စာများ:", { inline_keyboard: keyboard }, env);
}

async function showUserPanel(chatId, env) {
    const userKey = `user:${chatId}`;
    const userData = await env.MAIL_BOT_DB.get(userKey);
    const emailCount = userData ? JSON.parse(userData).createdEmails.length : 0;

    const text = `👤 **User Control Panel**

- သင်၏ Telegram ID: \`${chatId}\`
- ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\`

အောက်ပါခလုတ်များမှတစ်ဆင့် စီမံခန့်ခွဲနိုင်ပါသည်။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📧 Email များကြည့်ရန်", callback_data: "panel_my_emails" }],
            [{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "panel_create" }],
            [{ text: "🎲 ကျပန်းလိပ်စာ", callback_data: "panel_random" }],
        ]
    };
    await sendMessage(chatId, text, keyboard, env);
}


// --- Callback Query Handlers ---

async function handleCallbackQuery(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data;
  const [action, ...params] = data.split(":");

  await trackUserActivity(`user:${chatId}`, env);

  switch (action) {
    // User actions
    case "view_inbox":
      await viewInbox(chatId, params[0], env);
      break;
    case "refresh_inbox":
      await viewInbox(chatId, params[0], env, messageId);
      break;
    case "delete_email":
      await confirmDeleteEmail(chatId, messageId, params[0], env);
      break;
    case "delete_confirm":
      await deleteEmail(chatId, messageId, params[0], env);
      break;
    case "delete_cancel":
      await editMessage(chatId, messageId, "ဖျက်ခြင်းကို ပယ်ဖျက်လိုက်ပါသည်။", null, env);
      break;
    case "create_random":
        await createNewEmail(chatId, params[0], env);
        await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${params[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, null, env);
        break;
    case "generate_another":
        await generateRandomAddress(chatId, env, messageId);
        break;
    
    // User Panel actions
    case "panel_my_emails":
        await listUserEmails(chatId, env);
        break;
    case "panel_create":
        await requestEmailName(chatId, env);
        break;
    case "panel_random":
        await generateRandomAddress(chatId, env);
        break;

    // Admin actions
    case "admin_stats":
      await showAdminStats(chatId, messageId, env);
      break;
    case "admin_list_users":
      await listAllUsers(chatId, messageId, parseInt(params[0] || 1), env);
      break;
    case "admin_view_user":
      await viewUserEmailsAsAdmin(chatId, messageId, params[0], parseInt(params[1] || 1), env);
      break;
    case "admin_delete_email":
      await deleteEmailAsAdmin(chatId, messageId, params[0], params[1], env);
      break;
    case "admin_storage":
        await showStorageUsage(chatId, messageId, env);
        break;
    case "admin_inactive_users":
        await listInactiveUsers(chatId, messageId, parseInt(params[0] || 30), env);
        break;
    case "admin_back":
      await showAdminPanel(chatId, env, messageId);
      break;
  }
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery?callback_query_id=${callbackQuery.id}`);
}

async function viewInbox(chatId, email, env, messageId = null) {
  const emailKey = `email:${email}`;
  const emailData = await env.MAIL_BOT_DB.get(emailKey);

  if (!emailData) {
    await sendMessage(chatId, "❌ Error: Email not found.", null, env);
    return;
  }

  const { inbox } = JSON.parse(emailData);

  if (inbox.length === 0) {
    const text = `**Inbox: \`${email}\`**\n\n텅နေပါသည်! Email များ ရောက်ရှိမလာသေးပါ။`;
    const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }]] };
    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
    return;
  }

  let fileContent = `Inbox for: ${email}\n=========================\n\n`;
  for (const mail of inbox) {
    fileContent += `From: ${mail.from}\n`;
    fileContent += `Subject: ${mail.subject}\n`;
    fileContent += `Date: ${new Date(mail.receivedAt).toLocaleString('en-GB')}\n`;
    fileContent += `-------------------------\n`;
    fileContent += `${mail.body}\n\n`;
    fileContent += `=========================\n\n`;
  }
  
  const caption = `📥 **Inbox for \`${email}\`**\n\nစုစုပေါင်း email \`${inbox.length}\` စောင်ရှိပါသည်။ အသေးစိတ်အတွက် ဖိုင်ကို download လုပ်ပါ။`;
  const keyboard = { inline_keyboard: [[{ text: "🔄 Refresh", callback_data: `refresh_inbox:${email}` }]] };
  
  await sendDocument(chatId, fileContent, `inbox_${email}.txt`, caption, keyboard, env);
}

async function confirmDeleteEmail(chatId, messageId, email, env) {
  const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` ကို အပြီးတိုင် ဖျက်လိုပါသလား? ဤလုပ်ဆောင်ချက်ကို နောက်ပြန်လှည့်၍မရပါ။`;
  const keyboard = {
    inline_keyboard: [
      [
        { text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_confirm:${email}` },
        { text: "❌ မဟုတ်ပါ", callback_data: "delete_cancel" },
      ],
    ],
  };
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

  await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nလိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, null, env);
}

async function generateRandomAddress(chatId, env, messageId = null) {
    const cities = ["yangon", "mandalay", "naypyitaw", "bago", "mawlamyine", "pathein", "taunggyi", "sittwe", "myitkyina"];
    const nouns = ["post", "mail", "box", "connect", "link", "service"];
    const randomCity = cities[Math.floor(Math.random() * cities.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNumber = Math.floor(100 + Math.random() * 900);
    const randomName = `${randomCity}.${randomNoun}${randomNumber}`;
    
    const text = `🎲 **ကျပန်းလိပ်စာ**

အကြံပြုထားသော လိပ်စာမှာ:
\`${randomName}@${env.DOMAIN}\`

သင်ဤလိပ်စာကို အသုံးပြုလိုပါသလား?`;

    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဒီလိပ်စာကို ဖန်တီးမည်", callback_data: `create_random:${randomName}` }],
            [{ text: "🎲 နောက်တစ်ခု", callback_data: "generate_another" }]
        ]
    };

    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}


// --- Admin Panel Functions ---

async function showAdminPanel(chatId, env, messageId = null) {
  const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
      [{ text: "👥 Users List", callback_data: "admin_list_users:1" }],
      [{ text: "💾 Storage Usage", callback_data: "admin_storage" }],
      [{ text: "⏳ Inactive Users", callback_data: "admin_inactive_users:30" }],
    ],
  };
  if (messageId) {
    await editMessage(chatId, messageId, text, keyboard, env);
  } else {
    await sendMessage(chatId, text, keyboard, env);
  }
}

async function showAdminStats(chatId, messageId, env) {
  const allUserKeys = await env.MAIL_BOT_DB.list({ prefix: "user:" });
  const allEmailKeys = await env.MAIL_BOT_DB.list({ prefix: "email:" });

  const text = `📊 **Bot Statistics**

- စုစုပေါင်း User အရေအတွက်: \`${allUserKeys.keys.length}\`
- စုစုပေါင်း ဖန်တီးထားသော Email အရေအတွက်: \`${allEmailKeys.keys.length}\``;

  const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_back" }]] };
  await editMessage(chatId, messageId, text, keyboard, env);
}

async function listAllUsers(chatId, messageId, page, env) {
  const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
  const usersPerPage = 5;
  const totalPages = Math.ceil(allUserKeys.length / usersPerPage);
  page = Math.max(1, Math.min(page, totalPages));

  const start = (page - 1) * usersPerPage;
  const end = start + usersPerPage;
  const userPageKeys = allUserKeys.slice(start, end);

  let text = `👥 **Users List (Page ${page}/${totalPages})**\n\n`;
  const keyboardRows = [];

  if (userPageKeys.length === 0) {
      text += "User များမရှိသေးပါ။";
  } else {
      for (const key of userPageKeys) {
          const userId = key.name.split(":")[1];
          keyboardRows.push([{ text: `👤 ${userId}`, callback_data: `admin_view_user:${userId}:1` }]);
      }
  }

  const paginationRow = [];
  if (page > 1) {
    paginationRow.push({ text: "◀️ Prev", callback_data: `admin_list_users:${page - 1}` });
  }
  if (page < totalPages) {
    paginationRow.push({ text: "Next ▶️", callback_data: `admin_list_users:${page + 1}` });
  }
  if (paginationRow.length > 0) {
      keyboardRows.push(paginationRow);
  }

  keyboardRows.push([{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_back" }]);
  await editMessage(chatId, messageId, text, { inline_keyboard: keyboardRows }, env);
}

async function viewUserEmailsAsAdmin(chatId, messageId, targetUserId, page, env) {
  const userKey = `user:${targetUserId}`;
  const userData = await env.MAIL_BOT_DB.get(userKey);

  if (!userData || JSON.parse(userData).createdEmails.length === 0) {
    await editMessage(chatId, messageId, `User \`${targetUserId}\` has no created emails.`, {
        inline_keyboard: [[{ text: "⬅️ Users List သို့ပြန်သွားရန်", callback_data: "admin_list_users:1" }]]
    }, env);
    return;
  }

  const { createdEmails } = JSON.parse(userData);
  let text = `📧 **Emails for User: \`${targetUserId}\`**\n\n`;
  const keyboardRows = [];

  for (const email of createdEmails) {
    keyboardRows.push([
        { text: `📥 ${email}`, callback_data: `view_inbox:${email}` },
        { text: "🗑️ Delete", callback_data: `admin_delete_email:${email}:${targetUserId}` }
    ]);
  }
  
  keyboardRows.push([{ text: "⬅️ Users List သို့ပြန်သွားရန်", callback_data: "admin_list_users:1" }]);
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

    await editMessage(chatId, messageId, `✅ **Deleted!**\nEmail \`${emailToDelete}\` for user \`${targetUserId}\` has been deleted.`, {
        inline_keyboard: [[{ text: "⬅️ View User's Emails", callback_data: `admin_view_user:${targetUserId}:1` }]]
    }, env);
}

async function showStorageUsage(chatId, messageId, env) {
    const allKeys = await env.MAIL_BOT_DB.list();
    const text = `💾 **KV Storage Usage (Estimate)**

- စုစုပေါင်း Keys (Users + Emails): \`${allKeys.keys.length}\`

*မှတ်ချက်: Cloudflare Free Tier သည် KV Storage 1GB ပေးထားပါသည်။ အသေးစိတ်အချက်အလက်များကို Cloudflare Dashboard တွင် ကြည့်ရှုနိုင်ပါသည်။*`;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_back" }]] };
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
    if (inactiveUsers.length === 0) {
        text += "Inactive user မရှိပါ။";
    } else {
        text += inactiveUsers.map(id => `- \`${id}\``).join("\n");
    }

    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_back" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function trackUserActivity(userKey, env) {
    let userData = await env.MAIL_BOT_DB.get(userKey);
    let parsedData;
    if (userData) {
        parsedData = JSON.parse(userData);
    } else {
        // First time user
        parsedData = { createdEmails: [] };
    }
    parsedData.lastActive = new Date().toISOString();
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(parsedData));
}
