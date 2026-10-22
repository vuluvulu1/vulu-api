const Role = require('../models/Role');

// Paketlerin rollere göre görünürlüğü. Rolü olmayan paket herkese açıktır; adminler her paketi görür.

/** Kullanıcı bu paketi görebilir mi? */
function canSeePack(user, pack) {
    if (!user || !pack) return false;
    if (user.isAdmin) return true;
    const roles = pack.roles || [];
    if (!roles.length) return true;
    const mine = new Set((user.roles || []).map(String));
    return roles.some(r => mine.has(String(r)));
}

/** Kullanıcının görebildiği paketler için MongoDB sorgusu. */
function visiblePacksQuery(user) {
    if (user && user.isAdmin) return {};
    return { $or: [{ roles: { $exists: false } }, { roles: { $size: 0 } }, { roles: { $in: (user && user.roles) || [] } }] };
}

/** Rol kimliğinden { id, name, color }'a; profillerde rozet olarak gösterilir. */
async function roleMap() {
    const roles = await Role.find().sort({ createdAt: 1 }).lean();
    return new Map(roles.map(r => [String(r._id), { id: String(r._id), name: r.name, color: r.color }]));
}

const rolesOf = (user, map) => (user.roles || []).map(id => map.get(String(id))).filter(Boolean);

module.exports = { canSeePack, visiblePacksQuery, roleMap, rolesOf };
