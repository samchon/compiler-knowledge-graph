-- The Lua bulk exporter, run inside lua-language-server as a
-- `Lua.docScriptPath` build script.
--
-- Lua has no upstream SCIP indexer, and this is what stands in for one. It is
-- not a new analyzer: the server has already parsed and resolved the workspace
-- by the time this runs, and the whole job is to walk what it knows and write
-- it down. Everything here follows what `lua-probe.yml` observed rather than
-- what the API looked like it should do.
--
-- Two findings shaped it, both of which would have produced a broken exporter
-- that appeared to work:
--
--   * `vm.getExportableGlobals()` returns exportable globals only. A project
--     whose content is a module table held in a local — which is most Lua —
--     yields one entry. So enumeration goes through the workspace file list,
--     not the global table.
--   * `files.getAllUris` includes the server's own bundled meta files, so
--     without a root filter the Lua standard library lands in every project's
--     graph.
--
-- Positions are emitted as row/col through `guide.rowColOf`, and nothing is
-- digested here: the server ships no hashing primitive, so source digests are
-- computed by the caller that reads this artifact.
--
-- The injected environment is fixed by `script/cli/doc/init.lua`:
--   export, ws, vm, guide, getDesc, getLabel, jsonb, util, markdown
-- with `__index = _G`, so `require` reaches the rest of the server.

local original = export.serializeAndExport
local files = require 'files'
local furi = require 'file-uri'

---Return a portable path only when `absolute` is actually below `root`.
---
---A raw prefix is not containment: `/work/project-copy/a.lua` starts with
---`/work/project` but belongs to its sibling. Decoded file URIs use either
---slash spelling depending on the host, so the boundary accepts both.
local function relativeToRoot(absolute, root)
    if type(absolute) ~= 'string' or type(root) ~= 'string'
        or absolute:sub(1, #root) ~= root then
        return nil
    end
    local suffix = absolute:sub(#root + 1)
    if suffix == '' then
        return nil
    end
    local rootEnd = root:sub(-1)
    local suffixStart = suffix:sub(1, 1)
    if rootEnd ~= '/' and rootEnd ~= '\\'
        and suffixStart ~= '/' and suffixStart ~= '\\' then
        return nil
    end
    return suffix:gsub('^[/\\]+', ''):gsub('\\', '/')
end

-- Declaration kinds this exporter claims. Deliberately a list rather than
-- "anything with a name": a graph that emits every parser node it happens to
-- recognise cannot say what it proves, and the provider has to declare exactly
-- the facts its index supports.
local DECLARATIONS = {
    ['local'] = 'local',
    ['function'] = 'function',
    ['setglobal'] = 'global',
    ['setfield'] = 'field',
    ['setmethod'] = 'method',
    ['tablefield'] = 'field',
}

---The declaration's own name, or nil when the shape does not carry one.
---
---Returning nil rather than inventing a placeholder is the point: an anonymous
---function assigned into a table has no identity this exporter can prove, and
---counting the omissions is more honest than emitting a node called `?`.
local function nameOf(source)
    if type(source.name) == 'string' then
        return source.name
    end
    if type(source[1]) == 'string' then
        return source[1]
    end
    local field = source.field or source.method
    if type(field) == 'table' and type(field[1]) == 'string' then
        return field[1]
    end
    return nil
end

---The span covering a declaration's body, when it has one.
---
---LuaLS keeps a declaration's name and its body on different nodes: a function
---statement is a `setglobal` or `local` holding the name, and the node it holds
---carries the span of the whole `function … end`. The probe measured exactly
---this — a `setglobal` named `caller` spanning six characters whose `.value` was
---a `function` spanning thirty.
---
---That span is what lets a reference be attributed to the declaration it sits
---inside, which is the edge the graph actually wants: not "this symbol is used
---somewhere" but "this declaration references that one". A holder whose value
---is not a function — `local util = require 'util'` reports a `select` — has no
---body, and its own span stands.
local function bodyOf(source)
    local value = source.value
    if type(value) == 'table' and value.type == 'function'
        and value.start ~= nil and value.finish ~= nil then
        return value
    end
    return source
end

local function locationOf(uri, source, root)
    local startRow, startCol = guide.rowColOf(source.start)
    local finishRow, finishCol = guide.rowColOf(source.finish)
    local absolute = furi.decode(uri)
    if absolute == nil then
        return nil
    end
    -- Relative to the project, and only inside it. The uri list carries the
    -- server's bundled definitions too, and those are not this project's code.
    local relative = relativeToRoot(absolute, root)
    if relative == nil then
        return nil
    end
    return {
        file = relative,
        startLine = startRow,
        startColumn = startCol,
        endLine = finishRow,
        endColumn = finishCol,
    }
end

function export.serializeAndExport(docs, outputDir)
    local root = furi.decode(ws.rootUri)
    local report = {
        schemaVersion = 1,
        tool = {
            name = 'lua-language-server',
            exporter = 'samchon-graph-lua-export',
            exporterVersion = 1,
        },
        files = {},
        nodes = {},
        edges = {},
        -- Counted, not hidden. A consumer that cannot see how much was dropped
        -- cannot tell a sparse project from a failing exporter.
        skipped = { unnamed = 0, outsideRoot = 0, refsFailed = 0 },
        warnings = {},
    }

    if root == nil then
        report.warnings[#report.warnings + 1] =
            'workspace root uri did not decode; nothing was exported'
        util.saveFile(outputDir .. '/samchon-graph-lua.json', jsonb.beautify(report))
        return original(docs, outputDir)
    end

    local urisOk, uris = pcall(function()
        return files.getAllUris(ws.rootUri)
    end)
    if not urisOk or type(uris) ~= 'table' then
        report.warnings[#report.warnings + 1] =
            'files.getAllUris failed: ' .. tostring(uris)
        util.saveFile(outputDir .. '/samchon-graph-lua.json', jsonb.beautify(report))
        return original(docs, outputDir)
    end

    for _, uri in ipairs(uris) do
        local absolute = furi.decode(uri)
        local relative = absolute ~= nil
            and relativeToRoot(absolute, root)
            or nil
        if relative == nil then
            report.skipped.outsideRoot = report.skipped.outsideRoot + 1
            goto continue
        end

        local stateOk, state = pcall(function()
            return files.getState(uri)
        end)
        if not stateOk or type(state) ~= 'table' or state.ast == nil then
            report.warnings[#report.warnings + 1] =
                'could not parse ' .. tostring(uri)
            goto continue
        end

        report.files[#report.files + 1] = relative

        guide.eachSource(state.ast, function(source)
            local kind = DECLARATIONS[source.type]
            if kind == nil then
                return
            end
            local name = nameOf(source)
            if name == nil then
                report.skipped.unnamed = report.skipped.unnamed + 1
                return
            end
            local location = locationOf(uri, source, root)
            if location == nil then
                report.skipped.outsideRoot = report.skipped.outsideRoot + 1
                return
            end

            local index = #report.nodes + 1
            report.nodes[index] = {
                name = name,
                kind = kind,
                sourceType = source.type,
                location = location,
                -- Where the declaration's body ends, so a reference inside it
                -- can be attributed to it. Equal to `location` when the
                -- declaration has no body.
                body = locationOf(uri, bodyOf(source), root) or location,
            }

            -- The reason this exporter exists rather than the plain `--doc`
            -- output: references are resolved by the engine across files, and
            -- the documentation export omits them entirely.
            local refsOk, refs = pcall(function()
                return vm.getRefs(source)
            end)
            if not refsOk or type(refs) ~= 'table' then
                report.skipped.refsFailed = report.skipped.refsFailed + 1
                return
            end
            for _, ref in ipairs(refs) do
                if ref.start ~= nil and ref.finish ~= nil then
                    local refUri = guide.getUri(ref)
                    local refLocation = refUri ~= nil
                        and locationOf(refUri, ref, root)
                        or nil
                    if refLocation ~= nil then
                        report.edges[#report.edges + 1] = {
                            from = index,
                            kind = 'references',
                            sourceType = ref.type,
                            location = refLocation,
                        }
                    end
                end
            end
        end)

        ::continue::
    end

    local path = outputDir .. '/samchon-graph-lua.json'
    local saved, saveErr = util.saveFile(path, jsonb.beautify(report))
    if not saved then
        report.warnings[#report.warnings + 1] = tostring(saveErr)
    end
    print(('[samchon-graph] lua export: %d files, %d nodes, %d edges -> %s')
        :format(#report.files, #report.nodes, #report.edges, path))

    return original(docs, outputDir)
end
