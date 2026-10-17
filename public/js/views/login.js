/**
 * 登录页：邮箱密码登录 + 「用 Token 登录」的折叠入口。
 *
 * 服务端有没有配置 SESSION_SECRET 决定了是否开放账号登录；
 * 页面上不会把密码写到 localStorage 或任何其它本地存储里。
 */

import { lede } from '../cards.js';
import router from '../router.js';
import { getSession, login, loginWithToken } from '../store.js';
import { icon, toast, tpl } from '../ui.js';

/* ------------------------------------------------------------------ *
 * 邮箱密码表单
 * ------------------------------------------------------------------ */

function buildForm(ctx) {
  const error = tpl`<div class="formerror" hidden></div>`;
  const email = tpl`<input class="input" type="email" name="email" autocomplete="email" required placeholder="在 Iwara 注册的邮箱" />`;
  const password = tpl`<input class="input" type="password" name="password" autocomplete="current-password" required placeholder="账号密码" />`;
  const submit = tpl`<button class="btn btn--primary" type="submit" style="width:100%">${icon('shield')}<span>登录</span></button>`;
  const label = submit.querySelector('span');

  const form = tpl`
    <form>
      ${error}
      <label class="field"><span>邮箱</span>${email}</label>
      <label class="field"><span>密码</span>${password}</label>
      ${submit}
      <p class="desc" style="margin-top:10px;font-size:12.5px;color:var(--paper-3)">密码只在提交时发给本站 Worker 用于换取 Token，不会被写进 localStorage，也不会留在页面历史里。</p>
    </form>`;

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  const setBusy = (busy) => {
    submit.disabled = busy;
    label.textContent = busy ? '正在登录…' : '登录';
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    const emailValue = email.value.trim();
    const passwordValue = password.value;

    if (!emailValue || !passwordValue) {
      showError('邮箱和密码都要填。');
      (emailValue ? password : email).focus();
      return;
    }

    error.hidden = true;
    setBusy(true);
    try {
      await login(emailValue, passwordValue);
      // 成功后立刻丢掉明文密码，再离开这个页面。
      password.value = '';
      toast('登录成功');
      router.navigate('/');
      router.reload();
    } catch (err) {
      showError(err?.message || '登录失败，检查邮箱和密码后重试。');
      password.focus();
      password.select();
    } finally {
      setBusy(false);
    }
  };

  form.addEventListener('submit', onSubmit);
  ctx.onCleanup(() => form.removeEventListener('submit', onSubmit));
  return form;
}

/* ------------------------------------------------------------------ *
 * 用 Token 登录
 * ------------------------------------------------------------------ */

function buildTokenFold(ctx) {
  const error = tpl`<div class="formerror" hidden></div>`;
  const input = tpl`<input class="input" type="password" autocomplete="off" spellcheck="false" placeholder="粘贴 access token（形如 eyJ… 的 JWT）" />`;
  const submit = tpl`<button class="btn btn--sm" type="button">用这个 Token 登录</button>`;
  const idleLabel = '用这个 Token 登录';

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };

  const onClick = async () => {
    const value = input.value.trim();
    if (!value) {
      showError('先粘贴一个 Token。');
      input.focus();
      return;
    }
    error.hidden = true;
    submit.disabled = true;
    submit.textContent = '正在校验…';
    try {
      await loginWithToken(value);
      input.value = '';
      toast('Token 已保存，需要登录的接口会用它');
      router.navigate('/');
      router.reload();
    } catch (err) {
      showError(err?.message || '这个 Token 没能通过校验，确认没有复制漏字符。');
      submit.disabled = false;
      submit.textContent = idleLabel;
    }
  };

  submit.addEventListener('click', onClick);
  ctx.onCleanup(() => submit.removeEventListener('click', onClick));

  return tpl`
    <details style="margin-top:26px">
      <summary style="cursor:pointer;padding:6px 0;font-size:13.5px;color:var(--paper-2)">用 Token 登录</summary>
      <div style="padding-top:12px">
        <p class="desc" style="margin-bottom:10px;font-size:13px;color:var(--paper-3)">给无法使用邮箱密码的场景用：实例没有配置 SESSION_SECRET、账号开了两步验证，或者你手上已经有一个可用的 access token。配置了 SESSION_SECRET 的实例会把它加密存进 HttpOnly Cookie；没有配置时则只存在本机 localStorage，请求时以 X-Iwara-Token 透传给上游。</p>
        ${error}
        <label class="field"><span>Access Token</span>${input}</label>
        ${submit}
      </div>
    </details>`;
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export async function renderLogin(ctx) {
  const session = getSession();
  const head = lede({
    eyebrow: 'LOGIN',
    title: '登录 Iwara',
    desc: '登录后可以搜索、看收藏与评论。邮箱和密码只发给本站 Worker，由它向 Iwara 换取 Token。'
  });

  const card = tpl`<div class="panel" style="max-width:440px"></div>`;

  if (session.authenticated) {
    card.append(
      tpl`<div class="note">你已经登录为 ${session.user?.name || session.user?.username || 'Iwara 用户'}，不需要再登录一次。</div>`
    );
    card.append(
      tpl`<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:14px"><a class="btn btn--sm" href="#/">回到首页</a><a class="btn btn--sm" href="#/settings">看看设置</a></div>`
    );
  } else if (!session.loginEnabled) {
    card.append(
      tpl`<div class="note">这个实例没有开放账号登录：Worker 上没有配置 SESSION_SECRET，服务端拿不到加密会话所需的密钥，也就无法替你保存 Iwara 的 Token。想用需要登录的功能，可以在设置页填入自带的 access token——它只存在你本机浏览器，请求时以 X-Iwara-Token 透传给上游。</div>`
    );
    card.append(
      tpl`<div style="display:flex;gap:9px;flex-wrap:wrap;margin-top:14px"><a class="btn btn--primary btn--sm" href="#/settings">去设置页填 Token</a><a class="btn btn--sm" href="#/">回到首页</a></div>`
    );
  } else {
    card.append(buildForm(ctx));
  }

  card.append(buildTokenFold(ctx));

  return tpl`<div>${head}${card}</div>`;
}
