// Scope lint for the ExtendScript sources (acorn AST, no other deps).
//
//  - assignment to an undeclared identifier (ExtendScript silently creates a global)
//  - a for-loop counter that belongs to an enclosing function: recursion through
//    a closure then clobbers the caller's loop (this bit us in the FCPXML reader)

import * as acorn from "acorn";

const GLOBALS = new Set(["EDLAE", "$", "app", "alert", "confirm"]);

function children(node) {
    const out = [];
    for (const key of Object.keys(node)) {
        if (key === "type" || key === "start" || key === "end" || key === "loc") { continue; }
        const v = node[key];
        if (Array.isArray(v)) { for (const x of v) { if (x && typeof x.type === "string") { out.push(x); } } }
        else if (v && typeof v.type === "string") { out.push(v); }
    }
    return out;
}

function isFn(n) { return n.type === "FunctionDeclaration" || n.type === "FunctionExpression"; }

// Names declared directly in a function body (var + function declarations, hoisted) plus params.
function declaredIn(fnNode) {
    const names = new Set();
    if (fnNode.params) { for (const p of fnNode.params) { names.add(p.name); } }
    if (fnNode.type === "FunctionExpression" && fnNode.id) { names.add(fnNode.id.name); }
    (function walk(n) {
        for (const c of children(n)) {
            if (c.type === "VariableDeclaration") { for (const d of c.declarations) { names.add(d.id.name); } }
            if (c.type === "FunctionDeclaration") { names.add(c.id.name); continue; }
            if (c.type === "FunctionExpression") { continue; }
            if (c.type === "CatchClause" && c.param) { names.add(c.param.name); }
            walk(c);
        }
    })(fnNode.body || fnNode);
    return names;
}

export function lint(src, file) {
    const ast = acorn.parse(src, { ecmaVersion: 3, allowReserved: "never", sourceType: "script", locations: true });
    const problems = [];
    const scopes = [declaredIn(ast)];
    const where = (n) => `${file}:${n.loc.start.line}`;
    const resolve = (name) => {
        for (let i = scopes.length - 1; i >= 0; i--) { if (scopes[i].has(name)) { return i; } }
        return -1;
    };
    function checkAssign(id, n, isLoopInit) {
        if (!id || id.type !== "Identifier") { return; }
        const lvl = resolve(id.name);
        if (lvl < 0 && !GLOBALS.has(id.name)) { problems.push(`${where(n)} assignment to undeclared '${id.name}'`); }
        else if (isLoopInit && lvl >= 0 && lvl < scopes.length - 1) {
            problems.push(`${where(n)} loop counter '${id.name}' is declared in an outer function`);
        }
    }
    (function walk(n) {
        if (isFn(n)) {
            scopes.push(declaredIn(n));
            for (const c of children(n)) { walk(c); }
            scopes.pop();
            return;
        }
        if (n.type === "ForStatement" && n.init && n.init.type === "AssignmentExpression") {
            checkAssign(n.init.left, n, true);
        }
        if (n.type === "ForStatement" && n.init && n.init.type === "SequenceExpression") {
            for (const e of n.init.expressions) { if (e.type === "AssignmentExpression") { checkAssign(e.left, n, true); } }
        }
        if (n.type === "ForInStatement" && n.left.type === "Identifier") { checkAssign(n.left, n, true); }
        if (n.type === "AssignmentExpression") { checkAssign(n.left, n, false); }
        if (n.type === "UpdateExpression") { checkAssign(n.argument, n, false); }
        for (const c of children(n)) { walk(c); }
    })(ast);
    return problems;
}
