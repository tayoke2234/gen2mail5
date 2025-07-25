/**
 * Cloudflare Worker for a Telegram Temporary Email Bot
 * Author: Gemini (with user-requested features)
 * Version: 6.1 (The Interactive View Release)
 * Language: Burmese (Comments) & English (Code)
 * Features: Interactive view options, Robust parsing, Fallback mechanism, Timeout protection, Optimized parser, Interactive menu, Paginated inbox, User stats, Email forwarding setup, Admin panel, Broadcast, Email management, User management for admins, Persistent command menu.
 * Database: Cloudflare KV
 * Email Receiving: Cloudflare Email Routing
 * External Service: SendGrid (for forwarding)
 */

// --- Helper function for encoding/decoding emails in callbacks ---
const encode = (str) => encodeURIComponent(str);
const decode = (str) => decodeURIComponent(str);

// --- Main Handler ---
export default {
  async fetch(request, env, ctx) {
    if (request.method === "POST") {
      try {
        const payload = await request.json();
        if (payload.message) {
          ctx.waitUntil(handleMessage(payload.message, env));
        } else if (payload.callback_query) {
          ctx.waitUntil(handleCallbackQuery(payload.callback_query, env, ctx));
        }
      } catch (e) {
        console.error("Error parsing payload:", e);
      }
    }
    return new Response("OK");
  },

  async email(message, env) {
    const to = message.to.toLowerCase();
    const emailKey = `email:${to}`;

    const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
    if (!emailDataJSON) {
      console.log(`Email rejected for non-existent address: ${to}`);
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
    const rawEmailBytes = new Uint8Array(chunks.reduce((acc, chunk) => [...acc, ...chunk], []));
    const rawEmail = new TextDecoder("utf-8").decode(rawEmailBytes);

    const bodyMatch = rawEmail.match(/(?:\r\n\r\n|\n\n)([\s\S]*)/);
    let body = bodyMatch ? bodyMatch[1].trim() : "Empty Body";
    if (message.headers.get("content-transfer-encoding")?.toLowerCase() === 'base64') {
        try {
            body = atob(body.replace(/\s/g, ''));
        } catch (e) {
            console.log("Could not decode base64 body, using as is.");
        }
    }

    const newEmail = {
      from: message.headers.get("from") || "Unknown Sender",
      subject: message.headers.get("subject") || "No Subject",
      body: body,
      receivedAt: new Date().toISOString(),
    };

    let { inbox, owner } = JSON.parse(emailDataJSON);
    inbox.unshift(newEmail);

    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox, owner }));

    await sendMessage(
      owner,
      `📬 **Email အသစ်ရောက်ရှိ!**\n\nသင်၏လိပ်စာ \`${to}\` သို့ email အသစ်တစ်စောင် ရောက်ရှိနေပါသည်။ \n\nMenu မှ "📧 ကျွန်ုပ်၏ Email များ" ကိုနှိပ်ပြီး စစ်ဆေးနိုင်ပါသည်။`,
      null,
      env
    );
      
    const userData = await getUserData(owner, env);
    if (userData && userData.forwardEmail) {
        await forwardEmailWithThirdParty(userData.forwardEmail, newEmail, env);
    }
  },
};

// --- Telegram API Helper Functions ---

async function apiRequest(method, payload, env) {
    const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
    const response = await fetch(url, options);
    if (!response.ok) {
        const errorBody = await response.json();
        console.error(`Telegram API Error (${method}):`, errorBody);
    }
    return response;
}

async function sendMessage(chatId, text, reply_markup = null, env, parse_mode = "Markdown") {
    const payload = { chat_id: chatId, text, parse_mode, disable_web_page_preview: true };
    if (reply_markup) payload.reply_markup = reply_markup;
    return apiRequest('sendMessage', payload, env);
}

async function editMessage(chatId, messageId, text, reply_markup = null, env, parse_mode = "Markdown") {
    const payload = { chat_id: chatId, message_id: messageId, text, parse_mode, disable_web_page_preview: true };
    if (reply_markup) payload.reply_markup = reply_markup;
    return apiRequest('editMessageText', payload, env);
}

// --- State and User Management ---

async function getUserData(chatId, env) {
    const userKey = `user:${chatId}`;
    const data = await env.MAIL_BOT_DB.get(userKey);
    return data ? JSON.parse(data) : { createdEmails: [], lastActive: null, state: null, forwardEmail: null };
}

async function updateUserData(chatId, data, env) {
    const userKey = `user:${chatId}`;
    data.lastActive = new Date().toISOString();
    await env.MAIL_BOT_DB.put(userKey, JSON.stringify(data));
}

function isAdmin(chatId, env) {
    const adminIds = env.ADMIN_IDS ? env.ADMIN_IDS.split(",") : [];
    return adminIds.includes(chatId.toString());
}

// --- Message Handlers ---

async function handleMessage(message, env) {
    const chatId = message.chat.id;
    const text = message.text ? message.text.trim() : "";
    const userData = await getUserData(chatId, env);

    if (userData.state) {
        let stateHandled = true;
        switch (userData.state) {
            case 'awaiting_email_name':
                await createNewEmail(chatId, text.toLowerCase().split(" ")[0], userData, env);
                break;
            case 'awaiting_forward_email':
                await setForwardEmail(chatId, text, userData, env);
                break;
            case 'awaiting_broadcast_message':
                if (isAdmin(chatId, env)) {
                    await confirmBroadcast(chatId, text, env);
                }
                break;
            default:
                stateHandled = false;
        }
        if (stateHandled) {
            userData.state = null;
            await updateUserData(chatId, userData, env);
            return;
        }
    }

    if (text.startsWith('/')) {
        switch (text.toLowerCase()) {
            case "/start":
            case "/menu":
                await showMainMenu(chatId, env);
                break;
            case "/my_emails":
                await listUserEmails(chatId, env, null);
                break;
            case "/create_email":
                await requestEmailName(chatId, null, env);
                break;
            case "/admin_panel":
                if (isAdmin(chatId, env)) {
                    await showAdminPanel(chatId, env, null);
                } else {
                    await sendMessage(chatId, "🤔 Command ကို နားမလည်ပါ။ /start ကိုနှိပ်ပြီး menu ကိုပြန်ခေါ်နိုင်ပါသည်။", null, env);
                }
                break;
            case "/setup_menu":
                 if (isAdmin(chatId, env)) {
                    await setupCommands(chatId, env);
                }
                break;
            default:
                await sendMessage(chatId, "🤔 Command ကို နားမလည်ပါ။ /start ကိုနှိပ်ပြီး menu ကိုပြန်ခေါ်နိုင်ပါသည်။", null, env);
        }
        return;
    }
}

// --- Persistent Menu Setup ---
async function setupCommands(chatId, env) {
    await sendMessage(chatId, '⏳ Command menu များကို တပ်ဆင်နေပါသည်...', null, env);
    
    const userCommands = [
        { command: 'start', description: 'Bot ကိုစတင်ရန် (သို့) Menu ကိုပြရန်' },
        { command: 'my_emails', description: '📧 သင်၏ Email များကို ကြည့်ရှုရန်' },
        { command: 'create_email', description: '➕ Email လိပ်စာအသစ် ဖန်တီးရန်' },
    ];

    await apiRequest('setMyCommands', {
        commands: userCommands,
        scope: { type: 'default' }
    }, env);

    const adminCommands = [
        ...userCommands,
        { command: 'admin_panel', description: '👑 Admin Control Panel' }
    ];

    const adminIds = env.ADMIN_IDS ? env.ADMIN_IDS.split(",") : [];
    for (const adminId of adminIds) {
        await apiRequest('setMyCommands', {
            commands: adminCommands,
            scope: { type: 'chat', chat_id: adminId }
        }, env);
    }

    await sendMessage(chatId, '✅ Command menu များကို အောင်မြင်စွာ တပ်ဆင်ပြီးပါပြီ။', null, env);
}


// --- Main Menu and Core Features ---

async function showMainMenu(chatId, env, messageId = null) {
    const text = `👋 **မင်္ဂလာပါ၊ Temp Mail Bot မှ ကြိုဆိုပါတယ်။**\n\nအောက်ပါ Menu မှတစ်ဆင့် လုပ်ဆောင်ချက်များကို ရွေးချယ်နိုင်ပါသည်။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "create_email" }],
            [{ text: "🎲 ကျပန်းလိပ်စာ ဖန်တီးရန်", callback_data: "random_address" }],
            [{ text: "📧 ကျွန်ုပ်၏ Email များ", callback_data: "my_emails" }],
            [{ text: "⚙️ Forwarding တပ်ဆင်ရန်", callback_data: "setup_forwarding" }],
            [{ text: "📊 ကျွန်ုပ်၏ စာရင်းအင်း", callback_data: "user_stats" }],
        ]
    };

    if (isAdmin(chatId, env)) {
        keyboard.inline_keyboard.push([{ text: "👑 Admin Panel", callback_data: "admin_panel" }]);
    }

    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}

// --- Callback Query Handlers ---

async function handleCallbackQuery(callbackQuery, env, ctx) {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;
    const [action, ...params] = data.split(":");

    await apiRequest('answerCallbackQuery', { callback_query_id: callbackQuery.id }, env);
    
    const userData = await getUserData(chatId, env);
    await updateUserData(chatId, userData, env);

    const decodedParams = params.map(p => decode(p));

    switch (action) {
        case "main_menu": await showMainMenu(chatId, env, messageId); break;
        
        case "create_email": await requestEmailName(chatId, messageId, env); break;
        case "random_address": await generateRandomAddress(chatId, env, messageId); break;
        case "create_random": 
            await createNewEmail(chatId, decodedParams[0], userData, env);
            await editMessage(chatId, messageId, `✅ ကျပန်းလိပ်စာ \`${decodedParams[0]}@${env.DOMAIN}\` ကို အောင်မြင်စွာဖန်တီးပြီးပါပြီ။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
            break;
        case "generate_another": await generateRandomAddress(chatId, env, messageId); break;

        case "my_emails": await listUserEmails(chatId, env, messageId); break;
        case "view_inbox": await viewInbox(chatId, messageId, decodedParams[0], parseInt(decodedParams[1] || 1), env); break;
        
        // --- ပြင်ဆင်မှု အပိုင်း v6.1 ---
        // Email ကြည့်ရှုရန် ရွေးချယ်ခိုင်းသည့် menu အသစ်ကို ခေါ်ခြင်း
        case "view_email": 
            await showEmailViewOptions(chatId, messageId, decodedParams[0], parseInt(decodedParams[1]), parseInt(decodedParams[2]), env); 
            break;
        // ရွေးချယ်မှုအလိုက် သက်ဆိုင်ရာ function ကို ခေါ်ခြင်း
        case "view_email_clean": 
            await viewSingleEmail(chatId, messageId, decodedParams[0], parseInt(decodedParams[1]), parseInt(decodedParams[2]), 'clean', env); 
            break;
        case "view_email_raw": 
            await viewSingleEmail(chatId, messageId, decodedParams[0], parseInt(decodedParams[1]), parseInt(decodedParams[2]), 'raw', env); 
            break;

        case "delete_email_prompt": await confirmDeleteEmail(chatId, messageId, decodedParams[0], env); break;
        case "delete_email_confirm": await deleteEmail(chatId, messageId, decodedParams[0], env); break;

        case "user_stats": await showUserStats(chatId, messageId, env); break;
        case "setup_forwarding": await showForwardingSetup(chatId, messageId, env); break;
        case "set_forward_email": await requestForwardEmail(chatId, messageId, env); break;
        case "remove_forward_email": await removeForwardEmail(chatId, messageId, env); break;

        case "admin_panel": case "admin_back": await showAdminPanel(chatId, env, messageId); break;
        case "admin_stats": await showAdminStats(chatId, messageId, env); break;
        
        case "admin_broadcast": await requestBroadcastMessage(chatId, messageId, env); break;
        case "broadcast_confirm": 
            await executeBroadcast(chatId, messageId, decodedParams[0], env, ctx); 
            break;
        case "broadcast_cancel":
            await editMessage(chatId, messageId, "❌ Broadcast ကို ပယ်ဖျက်လိုက်ပါသည်။", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
            break;

        case "admin_manage_users": await listAllUsers(chatId, messageId, 1, env); break;
        case "list_users_page": await listAllUsers(chatId, messageId, parseInt(decodedParams[0]), env); break;
        case "admin_view_user": await showUserEmailsForAdmin(chatId, messageId, decodedParams[0], parseInt(decodedParams[1]), env); break;
        case "admin_delete_prompt":
            await confirmDeleteUserEmailForAdmin(chatId, messageId, decodedParams[0], decodedParams[1], decodedParams[2], env);
            break;
        case "admin_delete_confirm":
            await deleteUserEmailForAdmin(chatId, messageId, decodedParams[0], decodedParams[1], decodedParams[2], env);
            break;
    }
}


// --- Email Creation and Management ---

async function createNewEmail(chatId, name, userData, env) {
    if (!/^[a-z0-9.-]+$/.test(name)) {
        await sendMessage(chatId, "❌ **မှားယွင်းနေပါသည်!**\nနာမည်တွင် English အက္ခရာ အသေး (a-z)၊ ဂဏန်း (0-9)၊ နှင့် `.` `-` တို့သာ ပါဝင်ရပါမည်။ Space မပါရပါ။\n\nခလုတ်ကိုနှိပ်ပြီး ထပ်ကြိုးစားပါ။", { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'create_email' }]] }, env);
        return;
    }
    const email = `${name.toLowerCase()}@${env.DOMAIN}`;
    const emailKey = `email:${email}`;
    const existingEmail = await env.MAIL_BOT_DB.get(emailKey);
    if (existingEmail) {
        await sendMessage(chatId, `😥 **လိပ်စာအသုံးပြုပြီးသားပါ။**\n\`${email}\` သည် အခြားသူတစ်ယောက် အသုံးပြုနေပါသည်။ နာမည်အသစ်တစ်ခု ထပ်ကြိုးစားပါ။`, { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'create_email' }]] }, env);
        return;
    }
    
    await env.MAIL_BOT_DB.put(emailKey, JSON.stringify({ inbox: [], owner: chatId }));
    
    if (!userData.createdEmails.includes(email)) {
        userData.createdEmails.push(email);
    }
    await updateUserData(chatId, userData, env);
    
    await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်!**\nသင်၏ email လိပ်စာအသစ်မှာ:\n\n\`${email}\`\n\n"📧 ကျွန်ုပ်၏ Email များ" ကိုနှိပ်ပြီး စီမံခန့်ခွဲနိုင်ပါသည်။`, { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] }, env);
}

async function requestEmailName(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.state = 'awaiting_email_name';
    await updateUserData(chatId, userData, env);
    const text = `📧 **Email လိပ်စာအသစ် ဖန်တီးခြင်း**\n\nသင်အသုံးပြုလိုသော နာမည်ကို စာပြန်ရိုက်ထည့်ပေးပါ။ (Space မပါစေရ၊ English အက္ခရာနှင့် ဂဏန်းများသာ)။\n\nဥပမာ: \`myname123\`\n\nBot မှ သင့်နာမည်နောက်တွင် \`@${env.DOMAIN}\` ကို အလိုအလျောက် ထည့်ပေးပါလိမ့်မည်။`;
    const keyboard = { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] };
    
    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}


async function listUserEmails(chatId, env, messageId = null) {
    const userData = await getUserData(chatId, env);
    if (!userData || userData.createdEmails.length === 0) {
        const text = "텅နေပါသည်! သင်ဖန်တီးထားသော email များမရှိသေးပါ။";
        const keyboard = { inline_keyboard: [[{ text: "➕ Email အသစ်ဖန်တီးရန်", callback_data: "create_email" }], [{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] };
        if (messageId) await editMessage(chatId, messageId, text, keyboard, env);
        else await sendMessage(chatId, text, keyboard, env);
        return;
    }
    const keyboard = [];
    for (const email of userData.createdEmails) {
        keyboard.push([{ text: `📬 ${email}`, callback_data: `view_inbox:${encode(email)}:1` }]);
    }
    keyboard.push([{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]);
    const textToSend = "သင်၏ Email လိပ်စာများအား ကြည့်ရှုရန် (သို့) စီမံရန် ရွေးချယ်ပါ:";
    if (messageId) {
        await editMessage(chatId, messageId, textToSend, { inline_keyboard: keyboard }, env);
    } else {
        await sendMessage(chatId, textToSend, { inline_keyboard: keyboard }, env);
    }
}

async function generateRandomAddress(chatId, env, messageId = null) {
    const cities = ["yangon", "mandalay", "naypyitaw", "bago", "mawlamyine", "pathein", "taunggyi", "sittwe", "myitkyina"];
    const nouns = ["post", "mail", "box", "connect", "link", "service"];
    const randomCity = cities[Math.floor(Math.random() * cities.length)];
    const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
    const randomNumber = Math.floor(100 + Math.random() * 900);
    const randomName = `${randomCity}.${randomNoun}${randomNumber}`;
    const text = `🎲 **ကျပန်းလိပ်စာ**\n\nအကြံပြုထားသော လိပ်စာမှာ:\n\`${randomName}@${env.DOMAIN}\`\n\nသင်ဤလိပ်စာကို အသုံးပြုလိုပါသလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဒီလိပ်စာကို ဖန်တီးမည်", callback_data: `create_random:${encode(randomName)}` }],
            [{ text: "🎲 နောက်တစ်ခု", callback_data: "generate_another" }],
            [{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]
        ]
    };
    if (messageId) {
        await editMessage(chatId, messageId, text, keyboard, env);
    } else {
        await sendMessage(chatId, text, keyboard, env);
    }
}

async function viewInbox(chatId, messageId, emailAddress, page, env) {
    const emailKey = `email:${emailAddress}`;
    const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
    const { inbox } = emailDataJSON ? JSON.parse(emailDataJSON) : { inbox: [] };
    const EMAILS_PER_PAGE = 5;
    const totalPages = Math.max(1, Math.ceil(inbox.length / EMAILS_PER_PAGE));
    page = Math.max(1, Math.min(page, totalPages));
    const startIndex = (page - 1) * EMAILS_PER_PAGE;
    const endIndex = startIndex + EMAILS_PER_PAGE;
    const pageEmails = inbox.slice(startIndex, endIndex);
    let text = `📥 **Inbox for \`${emailAddress}\`**\n\n`;
    const keyboard = [];
    if (inbox.length === 0) {
        text += "텅နေပါသည်! Email များ ရောက်ရှိမလာသေးပါ။";
    } else {
        text += `စာမျက်နှာ ${page}/${totalPages} | စုစုပေါင်း ${inbox.length} စောင်`;
        pageEmails.forEach((mail, index) => {
            const originalIndex = startIndex + index;
            const subject = mail.subject.substring(0, 25) + (mail.subject.length > 25 ? '...' : '');
            // --- ပြင်ဆင်မှု အပိုင်း v6.1 ---
            // Callback data ကို view_email သို့ ပြောင်းလဲထားသည်
            keyboard.push([{ text: `📧 ${subject}`, callback_data: `view_email:${encode(emailAddress)}:${originalIndex}:${page}` }]);
        });
    }
    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "◀️ ရှေ့へ", callback_data: `view_inbox:${encode(emailAddress)}:${page - 1}` });
    }
    if (page < totalPages) {
        paginationRow.push({ text: "နောက်へ ▶️", callback_data: `view_inbox:${encode(emailAddress)}:${page + 1}` });
    }
    if (paginationRow.length > 0) {
        keyboard.push(paginationRow);
    }
    keyboard.push([
        { text: "🔄 Refresh", callback_data: `view_inbox:${encode(emailAddress)}:${page}` },
        { text: "🗑️ ဖျက်ရန်", callback_data: `delete_email_prompt:${encode(emailAddress)}` }
    ]);
    keyboard.push([{ text: "🔙 ကျွန်ုပ်၏ Email များသို့", callback_data: "my_emails" }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

// --- Email Parsing Functions ---
const escapeHTML = (str) => str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function parseToHTML(html) {
    let text = html.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    text = text.replace(/<(p|div|h[1-6]|blockquote|pre|li|tr|hr)\b[^>]*>/gi, "\n");
    text = text.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<a\s+[^>]*?href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (match, quote, url, linkText) => {
        const cleanedText = linkText.replace(/<[^>]+>/g, " ").trim();
        return `<a href="${escapeHTML(url)}">${escapeHTML(cleanedText || url)}</a>`;
    });
    text = text.replace(/<(b|strong)\b[^>]*>/gi, "<b>").replace(/<\/(b|strong)>/gi, "</b>");
    text = text.replace(/<(i|em)\b[^>]*>/gi, "<i>").replace(/<\/(i|em)>/gi, "</i>");
    text = text.replace(/<u>/gi, "<u>").replace(/<\/u>/gi, "</u>");
    text = text.replace(/<code>/gi, "<code>").replace(/<\/code>/gi, "</code>");
    text = text.replace(/<[^>]+>/g, ""); // Strip remaining tags
    text = text.replace(/&nbsp;/gi, ' ').replace(/&quot;/gi, '"').replace(/&apos;/gi, "'");
    return text.replace(/\n\s*\n/g, '\n\n').trim();
}

function parseToRawText(html) {
    let text = html.replace(/<br\s*\/?>/gi, "\n");
    text = text.replace(/<[^>]+>/g, " ");
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * --- Function အသစ် v6.1 ---
 * Email ကြည့်ရှုရန် နည်းလမ်းရွေးချယ်ခိုင်းသော Menu ကို ပြသပေးသည်။
 */
async function showEmailViewOptions(chatId, messageId, emailAddress, emailIndex, fromPage, env) {
    const text = "📧 **Email ကို ကြည့်ရှုရန်**\n\nEmail ကို ဘယ်လိုပုံစံနဲ့ ကြည့်ရှုလိုပါသလဲ။";
    const keyboard = {
        inline_keyboard: [
            [{ text: "👁️ ရှင်းလင်းစွာကြည့်ရန် (Recommended)", callback_data: `view_email_clean:${encode(emailAddress)}:${emailIndex}:${fromPage}` }],
            [{ text: "📄 မူရင်းစာသားအတိုင်းကြည့်ရန် (Error တက်လျှင်)", callback_data: `view_email_raw:${encode(emailAddress)}:${emailIndex}:${fromPage}` }],
            [{ text: `🔙 Inbox (Page ${fromPage}) သို့ပြန်သွားရန်`, callback_data: `view_inbox:${encode(emailAddress)}:${fromPage}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

/**
 * --- Function အသစ် v6.1 ---
 * Email ကို နည်းလမ်းအမျိုးမျိုးဖြင့် ပြသပေးသော মূল function။
 */
async function viewSingleEmail(chatId, messageId, emailAddress, emailIndex, fromPage, mode, env) {
    await editMessage(chatId, messageId, "⏳ Email ကို ပြင်ဆင်နေပါသည်...", null, env);

    try {
        const emailKey = `email:${emailAddress}`;
        const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
        const { inbox } = JSON.parse(emailDataJSON || '{}');

        if (!inbox || !inbox[emailIndex]) {
            await editMessage(chatId, messageId, "❌ **Error**\nEmail data ကို ရှာမတွေ့ပါ။", { inline_keyboard: [[{ text: `🔙 Inbox သို့ပြန်သွားရန်`, callback_data: `view_inbox:${encode(emailAddress)}:${fromPage}` }]] }, env);
            return;
        }
        const mail = inbox[emailIndex];
        
        let body;
        let parse_mode;

        if (mode === 'clean') {
            body = parseToHTML(mail.body);
            parse_mode = 'HTML';
        } else { // mode === 'raw'
            body = parseToRawText(mail.body);
            parse_mode = 'Markdown'; // Raw text is safe for Markdown
        }

        const truncatedBody = body.length > 3800 ? body.substring(0, 3800) + "\n\n[...Message Truncated...]" : body;
        
        let header;
        if (parse_mode === 'HTML') {
            header = `<b>From:</b> <code>${escapeHTML(mail.from)}</code>\n` +
                     `<b>Subject:</b> ${escapeHTML(mail.subject)}\n` +
                     `<b>Received:</b> <code>${new Date(mail.receivedAt).toLocaleString('en-GB')}</code>\n` +
                     `\n<pre>----------------------------------------</pre>\n`;
        } else {
            header = `**From:** \`${mail.from}\`\n` +
                     `**Subject:** \`${mail.subject}\`\n` +
                     `**Received:** \`${new Date(mail.receivedAt).toLocaleString('en-GB')}\`\n` +
                     `\n----------------------------------------\n\n`;
        }

        const fullMessage = header + truncatedBody;
        const keyboard = {
            inline_keyboard: [
                [{ text: `🔙 Inbox (Page ${fromPage}) သို့ပြန်သွားရန်`, callback_data: `view_inbox:${encode(emailAddress)}:${fromPage}` }]
            ]
        };

        await editMessage(chatId, messageId, fullMessage, keyboard, env, parse_mode);

    } catch (error) {
        console.error("Critical Error in viewSingleEmail:", error);
        await editMessage(chatId, messageId, "❌ **System Error**\nEmail ကိုပြသရာတွင် အမှားအယွင်းတစ်ခု ဖြစ်ပွားခဲ့ပါသည်။", { inline_keyboard: [[{ text: `🔙 Inbox သို့ပြန်သွားရန်`, callback_data: `view_inbox:${encode(emailAddress)}:${fromPage}` }]] }, env);
    }
}


async function confirmDeleteEmail(chatId, messageId, email, env) {
    const text = `🗑️ **အတည်ပြုပါ**\n\nသင် \`${email}\` ကို အပြီးတိုင် ဖျက်လိုပါသလား? ဤလုပ်ဆောင်ချက်ကို နောက်ပြန်လှည့်၍မရပါ။ Inbox ထဲမှ စာများအားလုံးပါ ဖျက်ပစ်ပါမည်။`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `delete_email_confirm:${encode(email)}` },
                { text: "❌ မဟုတ်ပါ", callback_data: `view_inbox:${encode(email)}:1` },
            ],
        ],
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteEmail(chatId, messageId, email, env) {
    const emailKey = `email:${email}`;
    const userData = await getUserData(chatId, env);
    if (userData) {
        userData.createdEmails = userData.createdEmails.filter(e => e !== email);
        await updateUserData(chatId, userData, env);
    }
    await env.MAIL_BOT_DB.delete(emailKey);
    await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nလိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, { inline_keyboard: [[{ text: "🔙 ကျွန်ုပ်၏ Email များသို့", callback_data: "my_emails" }]] }, env);
}


// --- User Stats and Forwarding ---

async function showUserStats(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    const emailCount = userData.createdEmails.length;
    let totalMessages = 0;

    for (const emailAddress of userData.createdEmails) {
        const emailKey = `email:${emailAddress}`;
        const emailDataJSON = await env.MAIL_BOT_DB.get(emailKey);
        if (emailDataJSON) {
            const emailData = JSON.parse(emailDataJSON);
            totalMessages += emailData.inbox.length;
        }
    }

    let text = `📊 **သင်၏ စာရင်းအင်းများ**\n\n`;
    text += `- 📧 ဖန်တီးထားသော Email အရေအတွက်: \`${emailCount}\`\n`;
    text += `- 📥 လက်ခံရရှိသော စာစုစုပေါင်း: \`${totalMessages}\`\n`;

    const keyboard = { inline_keyboard: [[{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function showForwardingSetup(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    let text = `⚙️ **Email Forwarding တပ်ဆင်ခြင်း**\n\nဤနေရာမှ သင်၏ယာယီလိပ်စာများသို့ ရောက်လာသော email များကို သင်၏ email အစစ်ဆီသို့ အလိုအလျောက် ပေးပို့ရန် 설정နိုင်ပါသည်။\n\n`;
    text += `**လက်ရှိအခြေအနေ:** `;
    
    const keyboard_rows = [];

    if (userData.forwardEmail) {
        text += `Forwarding လုပ်ရန် 설정ထားသော လိပ်စာမှာ \`${userData.forwardEmail}\` ဖြစ်ပါသည်။`;
        keyboard_rows.push([{ text: "🔄 Forwarding လိပ်စာပြောင်းရန်", callback_data: "set_forward_email" }]);
        keyboard_rows.push([{ text: "➖ Forwarding ကိုပယ်ဖျက်ရန်", callback_data: "remove_forward_email" }]);
    } else {
        text += `Forwarding မလုပ်ထားပါ။`;
        keyboard_rows.push([{ text: "➕ Forwarding လိပ်စာထည့်ရန်", callback_data: "set_forward_email" }]);
    }

    keyboard_rows.push([{ text: "🔙 Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard_rows }, env);
}

async function requestForwardEmail(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.state = 'awaiting_forward_email';
    await updateUserData(chatId, userData, env);

    const text = ` forward လုပ်လိုသော သင်၏ email အစစ်ကို ရိုက်ထည့်ပေးပါ။\n\nဥပမာ: \`my.real.email@gmail.com\``;
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "🔙 Forwarding Setup သို့ပြန်သွားရန်", callback_data: "setup_forwarding" }]] }, env);
}

async function setForwardEmail(chatId, email, userData, env) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        await sendMessage(chatId, `❌ **Email ပုံစံမမှန်ပါ။** \`${email}\` သည် မှန်ကန်သော email address မဟုတ်ပါ။ ထပ်ကြိုးစားပါ။`, { inline_keyboard: [[{ text: '➕ ထပ်ကြိုးစားမည်', callback_data: 'set_forward_email' }]] }, env);
        return;
    }
    userData.forwardEmail = email;
    await updateUserData(chatId, userData, env);
    await sendMessage(chatId, `✅ **အောင်မြင်ပါသည်။**\n\nယခုမှစ၍ email အသစ်များဝင်လာပါက \`${email}\` သို့ forward လုပ်ပေးပါမည်။`, { inline_keyboard: [[{ text: '🔙 Menu သို့ပြန်သွားရန်', callback_data: 'main_menu' }]] }, env);
}

async function removeForwardEmail(chatId, messageId, env) {
    const userData = await getUserData(chatId, env);
    userData.forwardEmail = null;
    await updateUserData(chatId, userData, env);

    const text = `✅ **Forwarding ကို ပယ်ဖျက်ပြီးပါပြီ။**\n\nယခုမှစ၍ email များကို forward လုပ်တော့မည်မဟုတ်ပါ။`;
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: '🔙 Menu သို့ပြန်သွားရန်', callback_data: 'main_menu' }]] }, env);
}

async function forwardEmailWithThirdParty(forwardTo, emailContent, env) {
    if (!env.SENDGRID_API_KEY || !env.FORWARD_FROM_EMAIL) {
        console.error("SendGrid API Key or From Email not configured. Skipping forward.");
        return;
    }
    const cleanedBodyForForwarding = parseToHTML(emailContent.body);
    const forwardBody = `<p>--- This is an automated forward from your Temp Mail Bot ---</p><p><b>Original Sender:</b> ${emailContent.from}</p><p><b>Original Subject:</b> ${emailContent.subject}</p><hr><div>${cleanedBodyForForwarding}</div>`;
    const sendGridPayload = {
        personalizations: [{ to: [{ email: forwardTo }] }],
        from: { email: env.FORWARD_FROM_EMAIL, name: "Temp Mail Bot" },
        subject: `[Forwarded] ${emailContent.subject}`,
        content: [{ type: "text/html", value: forwardBody }],
    };
    try {
        const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.SENDGRID_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify(sendGridPayload),
        });
        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`SendGrid Error: ${response.status} ${response.statusText} - ${errorBody}`);
        } else {
            console.log(`Successfully forwarded email to ${forwardTo}`);
        }
    } catch (error) {
        console.error("Failed to forward email via SendGrid:", error);
    }
}


// --- Admin Panel Functions ---

async function showAdminPanel(chatId, env, messageId = null) {
    const text = `⚙️ **Admin Control Panel**\n\nသင်သည် Admin အဖြစ်ဝင်ရောက်နေပါသည်။ အောက်ပါလုပ်ဆောင်ချက်များကို ရွေးချယ်ပါ။`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "📢 အားလုံးသို့စာပို့ရန် (Broadcast)", callback_data: "admin_broadcast" }],
            [{ text: "📊 Bot Stats", callback_data: "admin_stats" }],
            [{ text: "👤 User Management", callback_data: "admin_manage_users" }],
            [{ text: "🔙 Main Menu သို့ပြန်သွားရန်", callback_data: "main_menu" }],
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
    const text = `📊 **Bot Statistics**\n\n- စုစုပေါင်း User အရေအတွက်: \`${allUserKeys.keys.length}\`\n- စုစုပေါင်း ဖန်တီးထားသော Email အရေအတွက်: \`${allEmailKeys.keys.length}\``;
    const keyboard = { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function requestBroadcastMessage(chatId, messageId, env) {
    const adminData = await getUserData(chatId, env);
    adminData.state = 'awaiting_broadcast_message';
    await updateUserData(chatId, adminData, env);
    const text = "📢 **Broadcast Message**\n\nUser အားလုံးထံ ပေးပို့လိုသော စာသားကို ရေးပြီး ပို့ပေးပါ။\n\n*Markdown formatting အသုံးပြုနိုင်ပါသည်။*";
    await editMessage(chatId, messageId, text, { inline_keyboard: [[{ text: "❌ ပယ်ဖျက်မည်", callback_data: "admin_panel" }]] }, env);
}

async function confirmBroadcast(chatId, messageText, env) {
    const broadcastId = crypto.randomUUID();
    await env.MAIL_BOT_DB.put(`broadcast:${broadcastId}`, messageText, { expirationTtl: 600 });

    const text = `--- Preview ---\n\n${messageText}\n\n-----------------\n⚠️ အထက်ပါစာကို အသုံးပြုသူအားလုံးထံ ပေးပို့မှာသေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [
                { text: "✅ ဟုတ်ကဲ့၊ ပို့မည်", callback_data: `broadcast_confirm:${encode(broadcastId)}` },
                { text: "❌ မဟုတ်ပါ", callback_data: "broadcast_cancel" },
            ],
        ],
    };
    await sendMessage(chatId, text, keyboard, env);
}

async function executeBroadcast(chatId, messageId, broadcastId, env, ctx) {
    const messageText = await env.MAIL_BOT_DB.get(`broadcast:${broadcastId}`);
    
    if (!messageText) {
        await editMessage(chatId, messageId, "❌ **Error:** Broadcast message not found or has expired. Please try again.", { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
        return;
    }

    await env.MAIL_BOT_DB.delete(`broadcast:${broadcastId}`);

    await editMessage(chatId, messageId, "⏳ Broadcast ကို စတင်ပို့ဆောင်နေပါပြီ... ပြီးဆုံးပါက အကြောင်းကြားပါမည်။", null, env);

    ctx.waitUntil((async () => {
        const allUserKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
        let sentCount = 0;
        let failedCount = 0;
        
        for (const key of allUserKeys) {
            const targetUserId = key.name.split(":")[1];
            try {
                const res = await sendMessage(targetUserId, messageText, null, env);
                if (res.ok) {
                    sentCount++;
                } else {
                    failedCount++;
                }
                await new Promise(resolve => setTimeout(resolve, 100)); 
            } catch (e) {
                console.error(`Failed to send broadcast to ${targetUserId}: ${e}`);
                failedCount++;
            }
        }
        
        const reportText = `✅ **Broadcast ပြီးဆုံးပါပြီ!**\n\n- ✔️ ပေးပို့สำเร็จ: ${sentCount} ယောက်\n- ✖️ ပေးပို့မสำเร็จ: ${failedCount} ယောက်`;
        await sendMessage(chatId, reportText, { inline_keyboard: [[{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]] }, env);
    })());
}


async function listAllUsers(chatId, messageId, page, env) {
    await editMessage(chatId, messageId, "⏳ User စာရင်းကို ရှာဖွေနေပါသည်...", null, env);

    const userKeys = (await env.MAIL_BOT_DB.list({ prefix: "user:" })).keys;
    const USERS_PER_PAGE = 5;
    const totalPages = Math.max(1, Math.ceil(userKeys.length / USERS_PER_PAGE));
    page = Math.max(1, Math.min(page, totalPages));
    const startIndex = (page - 1) * USERS_PER_PAGE;
    const pageUserKeys = userKeys.slice(startIndex, startIndex + USERS_PER_PAGE);

    const text = `👤 **User Management** (Page ${page}/${totalPages})`;
    const keyboard = [];

    for (const key of pageUserKeys) {
        const targetUserId = key.name.split(":")[1];
        keyboard.push([{ text: `🆔 ${targetUserId}`, callback_data: `admin_view_user:${encode(targetUserId)}:${page}` }]);
    }

    const paginationRow = [];
    if (page > 1) {
        paginationRow.push({ text: "◀️ ရှေ့へ", callback_data: `list_users_page:${page - 1}` });
    }
    if (page < totalPages) {
        paginationRow.push({ text: "နောက်へ ▶️", callback_data: `list_users_page:${page + 1}` });
    }
    if (paginationRow.length > 0) {
        keyboard.push(paginationRow);
    }
    keyboard.push([{ text: "⬅️ Admin Panel သို့ပြန်သွားရန်", callback_data: "admin_panel" }]);

    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

async function showUserEmailsForAdmin(chatId, messageId, targetUserId, fromUserListPage, env) {
    await editMessage(chatId, messageId, `⏳ User ID: \`${targetUserId}\` ၏ email များကို ရှာဖွေနေပါသည်...`, null, env);

    const userData = await getUserData(targetUserId, env);
    let text = `📧 **Emails for User \`${targetUserId}\`**\n\n`;
    const keyboard = [];

    if (userData.createdEmails.length === 0) {
        text += "ဤ user သည် email တစ်ခုမှ မဖန်တီးထားပါ။";
    } else {
        for (const email of userData.createdEmails) {
            keyboard.push([{
                text: `🗑️ ${email}`,
                callback_data: `admin_delete_prompt:${encode(targetUserId)}:${encode(email)}:${fromUserListPage}`
            }]);
        }
    }

    keyboard.push([{ text: `🔙 User List (Page ${fromUserListPage}) သို့ပြန်သွားရန်`, callback_data: `list_users_page:${fromUserListPage}` }]);
    await editMessage(chatId, messageId, text, { inline_keyboard: keyboard }, env);
}

async function confirmDeleteUserEmailForAdmin(chatId, messageId, targetUserId, email, fromUserListPage, env) {
    const text = `🗑️ **Admin Deletion Confirmation**\n\nUser \`${targetUserId}\` ၏ email \`${email}\` ကို အပြီးတိုင် ဖျက်မှာ သေချာလား?`;
    const keyboard = {
        inline_keyboard: [
            [{ text: "✅ ဟုတ်ကဲ့၊ ဖျက်မည်", callback_data: `admin_delete_confirm:${encode(targetUserId)}:${encode(email)}:${fromUserListPage}` }],
            [{ text: "❌ မဟုတ်ပါ", callback_data: `admin_view_user:${encode(targetUserId)}:${fromUserListPage}` }]
        ]
    };
    await editMessage(chatId, messageId, text, keyboard, env);
}

async function deleteUserEmailForAdmin(chatId, messageId, targetUserId, email, fromUserListPage, env) {
    const emailKey = `email:${email}`;
    
    const targetUserData = await getUserData(targetUserId, env);
    
    if (targetUserData) {
        targetUserData.createdEmails = targetUserData.createdEmails.filter(e => e !== email);
        await updateUserData(targetUserId, targetUserData, env);
    }
    
    await env.MAIL_BOT_DB.delete(emailKey);
    
    await editMessage(chatId, messageId, `✅ **အောင်မြင်စွာဖျက်ပြီးပါပြီ။**\nUser \`${targetUserId}\` ၏ လိပ်စာ \`${email}\` ကို ဖျက်လိုက်ပါပြီ။`, {
        inline_keyboard: [[{ text: `🔙 User \`${targetUserId}\` ၏ စာရင်းသို့ ပြန်သွားရန်`, callback_data: `admin_view_user:${encode(targetUserId)}:${fromUserListPage}` }]]
    });

    await sendMessage(targetUserId, `ℹ️ **အသိပေးချက်**\n\nသင်၏ email လိပ်စာ \`${email}\` ကို Admin မှ ဖျက်လိုက်ပါသည်။`, null, env);
}
