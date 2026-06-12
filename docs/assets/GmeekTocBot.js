function loadResource(type, attributes, callback) {
    var element;
    if (type === 'script') {
        element = document.createElement('script');
        element.src = attributes.src;
        element.onload = callback;
    } else if (type === 'link') {
        element = document.createElement('link');
        element.rel = attributes.rel;
        element.href = attributes.href;
    } else if (type === 'style') {
        element = document.createElement('style');
        element.rel = 'stylesheet';
        element.appendChild(document.createTextNode(attributes.css));
    }
    document.head.appendChild(element);
}

function createTOC() {
    var tocElement = document.createElement('div');
    tocElement.className = 'toc';
    var contentContainer = document.getElementById('content');
    if (contentContainer.firstChild) {
        contentContainer.insertBefore(tocElement, contentContainer.firstChild);
    } else {
        contentContainer.appendChild(tocElement);
    }
}

document.addEventListener("DOMContentLoaded", function() {
    var headings = document.querySelectorAll('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6');
    if (headings.length < 2) return;

    headings.forEach(function(heading) {
        if (!heading.id) {
            heading.id = heading.textContent.trim().replace(/\s+/g, '-').toLowerCase();
        }
    });

    createTOC();
    var css = '.toc{position:fixed;top:130px;left:50%;transform:translateX(50%) translateX(320px);width:200px;padding-left:30px;max-height:70vh;overflow-y:auto;}'
        + '.toc .toc-list{list-style:none;padding-left:0;}'
        + '.toc .toc-link{display:block;padding:4px 0;font-size:14px;color:var(--color-fg-muted);text-decoration:none;line-height:1.5;}'
        + '.toc .toc-link:hover{color:var(--color-accent-fg);}'
        + '.toc .is-active-link{color:var(--color-accent-fg);font-weight:600;}'
        + '@media(max-width:1249px){.toc{position:static;top:auto;left:auto;transform:none;padding:10px;margin-bottom:20px;max-height:40vh;width:60%;}}';
    loadResource('style', {css: css});

    loadResource('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/tocbot/4.27.4/tocbot.min.js' }, function() {
        tocbot.init({
            tocSelector: '.toc',
            contentSelector: '.markdown-body',
            headingSelector: 'h1, h2, h3, h4, h5, h6',
            scrollSmooth: true,
            scrollSmoothOffset: -10,
            headingsOffset: 10,
            hasInnerContainers: false,
        });
    });

    loadResource('link', { rel: 'stylesheet', href: 'https://cdnjs.cloudflare.com/ajax/libs/tocbot/4.27.4/tocbot.css' });
    console.log("\n %c GmeekTocBot Plugins https://github.com/Meekdai/Gmeek \n","padding:5px 0;background:#C333D0;color:#fff");
});
