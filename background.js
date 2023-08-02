/* global chrome, browser */

function isChrome() {
  if (typeof (window) != 'undefined') {
    return window.navigator.userAgent.match('Chrome') ? true : false;
  }
  return true
}


function ba2str(ba) {
  let result = '';
  for (const b of ba) {
    result += String.fromCharCode(b);
  }
  return result;
}

function getHeaders(obj) {
  const x = obj.url.split('/');
  const host = x[2].split(':')[0];
  x.splice(0, 3);
  const resource_url = x.join('/');

  const http_version = ' HTTP/1.1';
  let headers = obj.method + ' /' + resource_url + http_version + '\r\n';
  // Chrome doesnt add Host header. Firefox does
  if (isChrome()) {
    headers += 'Host: ' + host + '\r\n';
  }
  for (let h of obj.requestHeaders) {
    // we dont want any "br" encoding
    if (h.name === 'Accept-Encoding') {
      // h.value = 'gzip, deflate'
      h.value = 'identity;q=1, *;q=0';
    }
    headers += h.name + ': ' + h.value + '\r\n';
  }
  if (obj.method === 'GET') {
    headers += '\r\n';
  }
  else if (obj.method === 'POST') {
    let content;
    if (obj.requestBody.raw !== undefined) {
      content = ba2str(new Uint8Array(obj.requestBody.raw[0].bytes));
    }
    else {
      const keys = Object.keys(obj.requestBody.formData);
      content = '';
      for (var key of keys) {
        content += key + '=' + obj.requestBody.formData[key] + '&';
      }
      // get rid of the last &
      content = content.slice(0, -1);
    }
    // Chrome doesn't expose Content-Length which chokes nginx
    headers += 'Content-Length: ' + parseInt(content.length) + '\r\n\r\n';
    headers += content;
  }
  let port = 443;
  if (obj.url.split(':').length === 3) {
    // the port is explicitely provided in URL
    port = parseInt(obj.url.split(':')[2].split('/')[0]);
  }
  return {
    'headers': headers,
    'server': host,
    'port': port
  };
}

function prepNotarization(tabId, urlFilters) {
  const oBR_handler = function (details) {
    if (details.method === "OPTIONS") return;
    chrome.webRequest.onBeforeRequest.removeListener(oBR_handler);
    chrome.storage.session.set({ "oBR_details": details })
  };
  chrome.webRequest.onBeforeRequest.addListener(
    oBR_handler, {
    urls: urlFilters,
    tabId: tabId,
    types: ['main_frame', 'xmlhttprequest']
    // types: ["main_frame", "sub_frame", "stylesheet", "script",
    // "image", "font", "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket", "other"]
  }, ['requestBody']);

  const oBSH_handler = function (details) {
    if (details.method === "OPTIONS") return;
    chrome.webRequest.onBeforeSendHeaders.removeListener(oBSH_handler);
    chrome.storage.session.set({ "oBSH_details": details })
  };
  const extraInfoSpec = ['requestHeaders'];
  if (isChrome()) extraInfoSpec.push('extraHeaders');
  chrome.webRequest.onBeforeSendHeaders.addListener(
    oBSH_handler, {
    urls: urlFilters,
    tabId: tabId,
    types: ['main_frame', 'xmlhttprequest']
  }, extraInfoSpec);

  const notarization = new Promise((resolve) => {
    const oSH_handler = async function (details) {
      if (details.method === "OPTIONS") return;
      chrome.webRequest.onSendHeaders.removeListener(oSH_handler);
      await recordHeaderDetails()

      // 2.1 In header listeners, update extension UI when the url filter is matched and header is stored
      chrome.action.setBadgeBackgroundColor(
        {
          color: 'green'
        },
      );
      chrome.action.setBadgeText(
        {
          text: 'ready'
        },
      )

      // 3. Create listener on the button event, have it
      const onClickNotary = async () => {
        chrome.action.onClicked.removeListener(onClickNotary);

        // 3.1 trigger the notary flow and return notarization future
        const result = await startNotarization()
        resolve(result)

        // 3.2 update extension UI to show process completed and no longer active
        chrome.action.setBadgeText(
          {
            text: ''
          },
        )

        // 3.3 close the tab
        chrome.tabs.remove(tabId)
      }
      chrome.action.onClicked.addListener(onClickNotary);
    };
    chrome.webRequest.onSendHeaders.addListener(
      oSH_handler, {
      urls: urlFilters,
      tabId: tabId,
      types: ['main_frame', 'xmlhttprequest']
    });
  })
  return notarization
}

async function recordHeaderDetails() {
  let oBR_details = await chrome.storage.session.get("oBR_details");
  let oBSH_details = await chrome.storage.session.get("oBSH_details");

  oBR_details = oBR_details.oBR_details;
  oBSH_details = oBSH_details.oBSH_details;

  if (oBR_details.url !== oBSH_details.url) return;
  // if (oBR_details.requestId !== oBSH_details.requestId) return;
  if (oBR_details.method === 'POST') {
    // POST payload is only available from onBeforeRequest
    oBSH_details['requestBody'] = oBR_details.requestBody;
  }
  const rv = getHeaders(oBSH_details);
  chrome.storage.session.set({
    "headerDetails": {
      headers: rv.headers,
      server: rv.server,
      port: rv.port,
    }
  })
}

async function startNotarization() {
  let headerDetails = await chrome.storage.session.get("headerDetails");
  return headerDetails
}

async function onInitiate(url, urlFilters) {
  // 1. Create new tab with the url
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = await chrome.tabs.create({
    openerTabId: activeTabs && activeTabs.length > 0 ? activeTabs[0].id : null
  })

  // 1.1 update extension UI to show it's active
  chrome.action.setBadgeBackgroundColor(
    {
      color: 'orange'
    },
  );
  chrome.action.setBadgeText(
    {
      text: 'active'
    },
  )

  // 2. With the returned tab id, create request header listeners over the url prefix, store header to session storage
  const notarization = prepNotarization(tab.id, urlFilters)

  // 2.2 Update the tab to have the url
  chrome.tabs.update(tabId = tab.id, { url: url })

  return notarization
}

const initiateNotary = async (message, sender, sendResponse) => {
  if (message === 'initiateNotary') {
    const result = await onInitiate("https://jomo.id/prove?flowId=103&publicAccountId=abcd", ["https://us-central1-jomo-omni.cloudfunctions.net/backend_apis/api/get_attestation_tree"])
    sendResponse(result);
  }
}
chrome.runtime.onMessageExternal.addListener(initiateNotary);