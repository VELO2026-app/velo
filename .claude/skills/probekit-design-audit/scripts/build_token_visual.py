#!/usr/bin/env python3
"""
build-token-visual -- render the design-system questions as something you can LOOK at.

Writes .tmp/design-questions.html (gitignored). Serve with the `tmp-static` entry
in .claude/launch.json (port 8765).

WHY A GENERATOR AND NOT A HAND-WRITTEN PAGE: the page inlines the REAL values
read out of variables.css at build time. Hand-copying hex into a review page is
how a review drifts from the thing it reviews -- the page would keep showing
yesterday's colours after someone edits a token, and the operator would rule on
a picture that is no longer true. Re-run this after any token change.

It renders questions. It does not answer them.

Usage: python .claude/skills/probekit-design-audit/scripts/build_token_visual.py
Run from the repo root.
"""
import io, json, os, re, subprocess, sys

TOKENS_CSS = 'frontend/src/styles/variables.css'
OUT = '.tmp/design-questions.html'
HERE = os.path.dirname(os.path.abspath(__file__))

# The app's REAL backdrop (global.css:236). Cards must be shown standing on THIS,
# not on white -- see BACKDROP below.
BG_SRC = 'frontend/public/bg/background.png'
BG_DST = '.tmp/_bg.png'

# BACKDROP -- the bug that made the first build of this page look broken
# (PROMPT №437). VELO's cards are white (--velo-bg-card-solid #ffffff) with a
# WHITE rim (--velo-border-card #ffffff). The first version of this page put
# them on a white panel, so card and rim and panel were all #ffffff and the
# "today" card rendered as literally nothing -- the flat-vs-elevated comparison
# had an empty left column and read as a broken page.
#
# It was not a CSS mistake so much as a CONTEXT mistake: the app does not stand
# its cards on white. body paints url('/bg/background.png') (global.css:236), and
# the white rim is what separates a white card FROM THAT PHOTO. Shown on the real
# backdrop the rim does visible work, and "are the shadows switched off or
# deliberate?" becomes an honest question instead of a leading one.


def strip_css_comments(t):
    return re.sub(r'/\*.*?\*/', lambda m: '\n' * m.group(0).count('\n'), t, flags=re.S)


def parse_tokens(path):
    clean = strip_css_comments(io.open(path, encoding='utf-8').read())
    out = {}
    for m in re.finditer(r'(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);', clean):
        out[m.group(1)] = ' '.join(m.group(2).split())
    return out


def resolve(v, tokens, seen=None):
    seen = seen or set()
    m = re.fullmatch(r'var\((--[A-Za-z0-9_-]+)\)', v.strip())
    if not m or m.group(1) in seen or m.group(1) not in tokens:
        return v
    return resolve(tokens[m.group(1)], tokens, seen | {m.group(1)})


def consumers():
    """Reuse the audited both-paths analysis rather than re-implementing it."""
    ref = os.path.join(HERE, 'derive_token_reference.py')
    raw = subprocess.run([sys.executable, ref, '--json'], capture_output=True, text=True,
                         encoding='utf-8').stdout
    return json.loads(raw)['consumers']


def screens_ru(cons, tok, limit=6):
    v = cons.get(tok, [])
    if not v:
        return '<span class="none">не используется нигде</span>'
    names = [x.replace('frontend/src/', '') for x in v]
    shown = ', '.join(names[:limit])
    if len(names) > limit:
        shown += ' <span class="more">и ещё %d</span>' % (len(names) - limit)
    return shown


def main():
    T = parse_tokens(TOKENS_CSS)
    R = {k: resolve(v, T) for k, v in T.items()}
    C = consumers()

    def val(n):
        return R.get(n, '')

    def sw(n):
        """One swatch: the colour, its name, its value, and who paints it.

        A token this page names may since have been DELETED (PROMPT №437 removed
        24 of them). val() would then return '' and the chip would render with no
        background -- an invisible swatch, the same class of bug that made the
        first build of this page look broken. Say «удалён» out loud instead."""
        if n not in R:
            return '''
      <div class="sw">
        <div class="chip" style="background:repeating-linear-gradient(45deg,#eef2f7,#eef2f7 6px,#dae2ec 6px,#dae2ec 12px)"></div>
        <div class="meta">
          <code>%s</code>
          <span class="val">удалён — PROMPT №437</span>
          <div class="use"><span class="none">токена больше нет в системе</span></div>
        </div>
      </div>''' % n
        return '''
      <div class="sw">
        <div class="chip" style="background:%s"></div>
        <div class="meta">
          <code>%s</code>
          <span class="val">%s</span>
          <div class="use">%s</div>
        </div>
      </div>''' % (val(n), n, val(n), screens_ru(C, n))

    white = ['--velo-white', '--velo-bg-card-solid', '--velo-border-card',
             '--velo-glass-border', '--velo-bg-start', '--velo-bg-end']
    brown = ['--velo-error-text', '--velo-warning-text', '--velo-peach-700']
    teal = ['--velo-success', '--velo-info', '--velo-mood-high', '--velo-teal-400']

    html = '''<!doctype html>
<meta charset="utf-8">
<title>VELO — вопросы по дизайн-системе</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; padding:32px; background:#eef2f7; color:#243447;
         font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; }
  h1 { font-size:26px; margin:0 0 6px; }
  .lede { color:#5b6b80; margin:0 0 28px; }
  section { background:#fff; border:1px solid #dae2ec; border-radius:12px;
            padding:22px 24px; margin:0 0 20px; }
  h2 { font-size:19px; margin:0 0 4px; }
  .q { color:#8a5a00; background:#fff6e5; border-left:3px solid #e0a53c;
       padding:9px 12px; border-radius:0 6px 6px 0; margin:12px 0 18px; }
  .verdict { color:#1f6b4a; background:#eaf7f0; border-left:3px solid #3bb38a;
             padding:9px 12px; border-radius:0 6px 6px 0; margin:12px 0 18px; }
  .sw { display:flex; gap:14px; align-items:center; padding:9px 0;
        border-bottom:1px solid #f0f4f8; }
  .sw:last-child { border-bottom:0; }
  .chip { width:76px; height:46px; border-radius:8px; border:1px solid #cdd8e5;
          flex:none; }
  .meta { min-width:0; }
  code { font:13px ui-monospace,Menlo,Consolas,monospace; color:#243447; }
  .val { color:#7d8b9c; font-size:12px; margin-left:8px; }
  .use { color:#5b6b80; font-size:12.5px; margin-top:3px; }
  .none { color:#b4321f; font-weight:600; }
  .more { color:#98a6b6; }
  .row { display:flex; gap:18px; flex-wrap:wrap; }
  .col { flex:1; min-width:260px; }
  .cap { font-size:12.5px; color:#7d8b9c; text-transform:uppercase;
         letter-spacing:.04em; margin:0 0 8px; }
  .banner { display:flex; gap:12px; border:1px solid; border-radius:10px;
            padding:14px 16px; }
  .banner b { display:block; font-weight:600; margin-bottom:2px; }
  /* The app's real backdrop -- cards MUST stand on this, not on white. */
  .stage { background:url('_bg.png') center/cover no-repeat; border-radius:10px;
           padding:20px; border:1px solid #dae2ec; }
  .card { background:%(cardbg)s; border:1px solid %(bordercard)s;
          border-radius:12px; padding:18px; color:#243447; }
  .stack { display:flex; flex-direction:column; gap:16px; }
  .note { color:#5b6b80; font-size:13.5px; margin-top:10px; }
</style>
<div class="wrap">
<h1>VELO — вопросы по дизайн-системе</h1>
<p class="lede">Здесь только то, что нельзя решить по хекс-кодам: надо посмотреть.
Значения прочитаны прямо из <code>variables.css</code> — страница не может разойтись
с системой. Ничего не изменено, это вопросы.</p>
''' % {'bordercard': val('--velo-border-card'), 'cardbg': val('--velo-bg-card-solid')}

    # ---- 1. shadows
    html += '''
<section>
  <h2>1. Тени: выключены или так задумано?</h2>
  <div class="q">Четыре токена тени и три «возвышения» равны <code>none</code>.
  Но два компонента ТРЕБУЮТ тень и получают пустоту:
  <b>модальное окно</b> (<code>VModal</code> просит <code>--shadow-xl</code>) и
  <b>карточка-цифра</b> (<code>VStatCard</code> просит <code>--shadow-md</code>).
  Карточки стоят на настоящем фоне приложения — белый кант карточки отделяет её
  от фото. Вопрос: канта достаточно, или модалке нужна тень, чтобы оторваться от
  контента?</div>
  <div class="row">
    <div class="col">
      <p class="cap">Сейчас (тень = none)</p>
      <div class="stage"><div class="stack">
        <div class="card">
          <b>Всего практик</b><div style="font-size:30px">128</div>
        </div>
        <div class="card" style="box-shadow:none">
          <b>Модальное окно</b>
          <div class="note">Только белый кант. Тени нет.</div>
        </div>
      </div></div>
    </div>
    <div class="col">
      <p class="cap">Если тень включить</p>
      <div class="stage"><div class="stack">
        <div class="card" style="box-shadow:0 1px 3px rgba(36,52,71,.14)">
          <b>Всего практик</b><div style="font-size:30px">128</div>
        </div>
        <div class="card" style="box-shadow:0 12px 32px rgba(36,52,71,.20)">
          <b>Модальное окно</b>
          <div class="note">Окно отрывается от фона.</div>
        </div>
      </div></div>
    </div>
  </div>
  <p class="note">Свечение при этом работает: <code>--velo-shadow-glow</code>
  (<code>%s</code>) используется на 15 экранах. Выключена именно лесенка теней.
  Поэтому «плоско задумано» — правдоподобный ответ: кант уже делает работу.
  Но тогда почему <code>VModal</code> просит <code>--shadow-xl</code>?</p>
</section>''' % val('--velo-shadow-glow')

    # ---- 2. error banner trap
    html += '''
<section>
  <h2>2. Ошибка выглядит как предупреждение — ИСПРАВЛЕНО</h2>
  <div class="verdict">РЕШЕНО (PROMPT №437): ошибка теперь красная.
  <code>--velo-error-text</code> был коричневым <code>#a16124</code> — тем же, что
  у предупреждения; отличался только фон. Теперь это алиас
  <code>--velo-danger-text</code>, красного, который в продукте уже означает
  «плохо». Визуально сегодня не изменилось ничего: <code>variant="error"</code>
  не отрисован ни на одном экране — ловушка закрыта до того, как в неё попали.
  Ниже — что стало и что было.</div>
  <div class="row">
    <div class="col">
      <p class="cap">Предупреждение</p>
      <div class="banner" style="background:%(wbg)s;border-color:%(wbd)s">
        <div><b style="color:%(wtitle)s">Внимание</b>
        <span style="color:%(wbody)s">Практика начнётся через 10 минут</span></div>
      </div>
    </div>
    <div class="col">
      <p class="cap">Ошибка — как сейчас, после правки</p>
      <div class="banner" style="background:%(ebg)s;border-color:%(ebd)s">
        <div><b style="color:%(etext)s">Ошибка</b>
        <span style="color:%(etext)s">Не удалось сохранить изменения</span></div>
      </div>
    </div>
  </div>
  <p class="note">Каждый баннер нарисован своими настоящими токенами из
  <code>Banner.vue</code>: предупреждение — <code>--velo-peach-700</code>,
  ошибка — <code>--velo-error-text</code> (теперь алиас
  <code>--velo-danger-text %(etext)s</code>). Ниже — как ошибка выглядела ДО
  правки: тот же коричневый, что у предупреждения, отличался только фон.</p>
  <div class="banner" style="background:%(ebg)s;border-color:%(ebd)s;margin-top:10px">
    <div><b style="color:%(wtitle)s">Ошибка</b>
    <span style="color:%(wtitle)s">Не удалось сохранить изменения</span></div>
  </div>
</section>''' % {
        'wtitle': val('--velo-peach-700'), 'wbg': val('--velo-glass-peach-40'),
        'wbd': val('--velo-warning-border'), 'wbody': val('--velo-peach-500'),
        'ebg': val('--velo-error-bg'), 'ebd': val('--velo-error-border'),
        'etext': val('--velo-error-text'),
    }
    html += '<section><h2>Тот же коричневый под тремя именами</h2>' \
            + ''.join(sw(n) for n in brown) + '</section>'

    # ---- 3. success/info
    html += '''
<section>
  <h2>3. «Успех» и «инфо» — один цвет</h2>
  <div class="verdict">Решать не срочно: всё семейство <code>--velo-info*</code>
  не используется НИГДЕ. Различие существует только в названиях.
  Вопрос простой: инфо должен отличаться от успеха — или инфо лишний?</div>
''' + ''.join(sw(n) for n in teal) + '</section>'

    # ---- 4. white
    html += '''
<section>
  <h2>4. Белый под шестью именами</h2>
  <div class="verdict">Наша рекомендация: НЕ ТРОГАТЬ. Это разные роли, которые
  сегодня совпали в значении, — так и должно быть в дизайн-системе. Опасность
  обратная: если кто-то «схлопнет» их в один токен, то, покрасив границу карточки,
  он покрасит и фон. Показываем, чтобы ты это видел, а не чтобы менять.
  Исключение — <code>--velo-bg-end</code> внизу: он не используется нигде,
  то есть градиент фона «из белого в белый» просто не существует.</div>
  <p class="cap">Белый кант на настоящем фоне — он делает видимую работу</p>
  <div class="stage" style="margin-bottom:18px">
    <div class="card"><b>Карточка практики</b>
    <div class="note">Белый фон + белый кант. На фото это читается как край карточки —
    поэтому шесть «одинаковых» белых не одно и то же.</div></div>
  </div>
''' + ''.join(sw(n) for n in white) + '</section>'

    html += '''
<p class="lede">Не здесь и решается отдельно: 563 числа в пикселях, вписанных руками,
и 187 пар токенов, различающихся на 1–2px. Это вопросы принципа, а не цвета.</p>
</div>'''

    os.makedirs('.tmp', exist_ok=True)

    # Copy the app's real backdrop next to the page. The page is served from
    # .tmp by the tmp-static launch entry, which cannot reach frontend/public.
    import shutil
    if os.path.exists(BG_SRC):
        shutil.copyfile(BG_SRC, BG_DST)
    else:
        print('WARNING: %s missing -- cards will render on a flat panel and the '
              'white rim will be invisible. Fix the path, do not ship this.' % BG_SRC)

    # SELF-CHECK: refuse to ship a page whose demo cards are invisible. This is
    # the exact bug that shipped in the first build -- card, rim and panel all
    # #ffffff, so the "today" column rendered as nothing and the page read as
    # broken. Cheap guard against showing the operator a lie.
    if val('--velo-bg-card-solid').lower() == val('--velo-border-card').lower() \
            and not os.path.exists(BG_DST):
        print('ABORT: card background == card border and no backdrop to stand them on.')
        sys.exit(1)

    io.open(OUT, 'w', encoding='utf-8', newline='').write(html)
    print('wrote %s (%d bytes)' % (OUT, len(html)))
    print('backdrop: %s' % ('copied ' + BG_DST if os.path.exists(BG_DST) else 'MISSING'))


if __name__ == '__main__':
    main()
