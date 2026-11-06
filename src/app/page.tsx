import Image from "next/image";
import Link from "next/link";
import { publicConfig } from "@/lib/public-config";
import { buildResourceReleases } from "@/lib/resource-releases";
import { getResourceReleaseSettings } from "@/lib/release-settings";
import { SponsorWorkspace } from "@/components/sponsor-workspace";

export const dynamic = "force-dynamic";

export default async function Home() {
  const resourceReleases = buildResourceReleases(
    await getResourceReleaseSettings(),
  );
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
          <a href="#releases">更新日志</a>
          <a href="#guide">领取说明</a>
        </nav>
      </header>
      <main id="main-content">
        <section className="resource-heading" aria-labelledby="resource-title">
          <div>
            <h1 id="resource-title">{publicConfig.resourceName}</h1>
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
        <div className="resource-layout">
          <aside className="resource-context" aria-label="资源与支持说明">
            <div className="risk-note">
              <strong>先核对，再刷机</strong>
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
                <span className="identity-separator" aria-hidden="true">
                  ≠
                </span>
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
              <p className="identity-explanation">
                赞助者仅提供赞助支持，并非作者；不提供刷机指导或故障排查。作者目前也无法提供技术指导。
              </p>
            </section>
          </aside>
          <SponsorWorkspace />
        </div>
        <section
          className="release-notes"
          id="releases"
          aria-labelledby="releases-title"
        >
          <div className="release-heading">
            <h2 id="releases-title">更新日志</h2>
            <p>刷机包的维护内容与支持范围</p>
          </div>
          <div className="release-list">
            {resourceReleases.map((release) => (
              <article
                className="release-entry"
                key={release.id}
                aria-labelledby={`release-${release.id}`}
              >
                <div className="release-meta">
                  <span className="release-badge">{release.label}</span>
                  <span className="release-version">发布日期</span>
                  {release.publishedAt && (
                    <time dateTime={release.publishedAt}>
                      {release.publishedAt.replaceAll("-", ".")}
                    </time>
                  )}
                </div>
                <div className="release-body">
                  <h3 id={`release-${release.id}`}>{release.title}</h3>
                  <div className="release-columns">
                    {release.sections.map((section) => (
                      <div
                        key={section.title}
                        className={
                          section.title === "已知问题"
                            ? "release-issues"
                            : undefined
                        }
                      >
                        <h4>{section.title}</h4>
                        <ul>
                          {section.items.map((item, index) => (
                            <li key={index}>{item}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <div className="release-footer">
                    <p>刷机有风险，请先备份重要数据。</p>
                    <a
                      href={publicConfig.demoUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      核对演示说明 ↗
                    </a>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
        <section
          className="usage-guide"
          id="guide"
          aria-labelledby="guide-title"
        >
          <h2 id="guide-title">赞助与领取说明</h2>
          <div className="guide-columns">
            <div>
              <h3>匿名，也可以领取</h3>
              <p>QQ 号选填。留空仍可确认并获取资源，也不会出现在公开名单中。</p>
            </div>
            <div>
              <h3>刷机前，先核对</h3>
              <p>
                机型与操作步骤请先以演示说明核对，并备份重要数据。
                <a href={publicConfig.demoUrl} target="_blank" rel="noreferrer">
                  查看 B 站演示 ↗
                </a>
              </p>
            </div>
            <div>
              <h3>回来时，不必再确认</h3>
              <p>
                同一浏览器内可恢复 7
                天。清除浏览器数据、换设备或记录被删除后，可能无法恢复。
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
