import Image from "next/image";
import Link from "next/link";
import { publicConfig } from "@/lib/public-config";
import { SponsorWorkspace } from "@/components/sponsor-workspace";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <Link href="/" className="brand" aria-label="Flashpay 首页">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          Flashpay
          <span className="brand-divider" />
          资源交付
        </Link>
        <nav aria-label="主导航">
          <a href="#guide">使用说明</a>
          <a href={publicConfig.demoUrl} target="_blank" rel="noreferrer">
            B 站演示 ↗
          </a>
        </nav>
      </header>
      <main id="main-content">
        <section className="resource-heading" aria-labelledby="resource-title">
          <div>
            <h1 id="resource-title">{publicConfig.resourceName}</h1>
            <p>{publicConfig.resourceDescription}</p>
          </div>
          <a
            className="demo-link"
            href={publicConfig.demoUrl}
            target="_blank"
            rel="noreferrer"
          >
            <span className="play-mark" aria-hidden="true">
              ▶
            </span>
            <span>
              先看演示，再动手<small>在 B 站打开 ↗</small>
            </span>
          </a>
        </section>
        <div className="risk-note">
          <strong>刷机前请注意</strong>
          <p>
            {publicConfig.compatibility}{" "}
            刷机有数据丢失或设备无法启动的风险，请先备份重要数据。
          </p>
        </div>
        <section
          className="identity-note"
          aria-label="刷机包作者与项目赞助者说明"
        >
          <div className="identity-people">
            <figure>
              <Image
                src="/identity/project-sponsor-avatar.png"
                alt="项目赞助者头像"
                width={48}
                height={48}
              />
              <figcaption>项目赞助者</figcaption>
            </figure>
            <figure>
              <Image
                src="/identity/package-author-avatar.png"
                alt="刷机包作者头像"
                width={48}
                height={48}
              />
              <figcaption>刷机包作者</figcaption>
            </figure>
          </div>
          <div className="identity-explanation">
            <p>
              本刷机包由作者制作，项目赞助者仅提供赞助支持，并非刷机包作者。
            </p>
            <p>
              <strong>
                项目赞助者无法提供刷机指导、故障排查等技术帮助，请勿向赞助者咨询技术问题。
              </strong>
            </p>
            <p>由于时间有限，作者目前无法提供技术指导，敬请理解与谅解。</p>
          </div>
        </section>
        <SponsorWorkspace />
        <section
          className="usage-guide"
          id="guide"
          aria-labelledby="guide-title"
        >
          <h2 id="guide-title">开始之前，了解这几件事</h2>
          <div className="guide-columns">
            <div>
              <h3>按自己的心意支持</h3>
              <p>
                任意合法金额都可获取同一份资源。静态收款码不会带入所选金额，请在微信内手动填写。
              </p>
            </div>
            <div>
              <h3>自主确认后交付</h3>
              <p>
                本网站不接入支付核验。点击「我已支付」提交自主确认，记录保存成功后提供资源地址。
              </p>
            </div>
            <div>
              <h3>回来时，不必再确认</h3>
              <p>
                同一浏览器内，7
                天可恢复入口。清除浏览器数据、换设备或记录被删除后，可能无法恢复。
              </p>
            </div>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <div>
          <Link href="/privacy">隐私说明</Link>
        </div>
      </footer>
    </div>
  );
}
