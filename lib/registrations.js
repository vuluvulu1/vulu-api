// Kayıt isteğinden gerçek hesap açar: admin onayı ve (ayar 'auto' ise) e-posta doğrulaması ortak kullanır.
const User = require('../models/User');
const Registration = require('../models/Registration');

/**
 * İsteği kullanıcıya çevirir ve isteği siler.
 * @returns {{ user?: object, error?: string }} Aynı adla bir hesap varsa error döner ve istek kaldırılır.
 */
async function createUserFromRegistration(reg) {
    // İstek beklerken aynı adla elle bir kullanıcı açılmış olabilir
    if (await User.exists({ username: new RegExp(`^${reg.username}$`, 'i') })) {
        await Registration.deleteOne({ _id: reg._id });
        return { error: `"${reg.username}" adında bir kullanıcı zaten var; istek kaldırıldı.` };
    }
    const user = await User.create({
        username: reg.username,
        email: reg.email,
        passwordHash: reg.passwordHash,
        isActive: true,
        isAdmin: false,
    });
    await Registration.deleteOne({ _id: reg._id });
    return { user };
}

module.exports = { createUserFromRegistration };
