// services/accountDeletion.js — Suppression complète d'un compte (RGPD)
// Utilisé par l'admin (DELETE /api/admin/users/:id) et par l'utilisateur lui-même
// (DELETE /api/auth/account). Supprime toutes les données en base, puis les fichiers R2.

const prisma = require('../prisma/client');
const { deleteR2Object } = require('../lib/r2');

/** Liste les fichiers (URLs) appartenant au compte, à effacer du stockage après suppression */
async function collectFileUrls(tx, userId, profileId, eventIds, bookingIds) {
  const urls = [];
  const push = (...values) => values.forEach(v => { if (v) urls.push(v); });

  if (profileId) {
    const profile = await tx.profile.findUnique({ where: { id: profileId }, select: { avatar: true, banner: true } });
    push(profile?.avatar, profile?.banner);

    const pubs = await tx.publication.findMany({
      where: { profileId },
      select: { media: true, additionalMedia: { select: { url: true } } },
    });
    pubs.forEach(p => { push(p.media); p.additionalMedia.forEach(m => push(m.url)); });

    const albumItems = await tx.albumItem.findMany({ where: { album: { profileId } }, select: { mediaUrl: true } });
    albumItems.forEach(a => push(a.mediaUrl));

    const media = await tx.media.findMany({ where: { OR: [{ profileId }, { userId }] }, select: { url: true } });
    media.forEach(m => push(m.url));

    if (eventIds.length) {
      const events = await tx.event.findMany({ where: { id: { in: eventIds } }, select: { coverImage: true } });
      events.forEach(e => push(e.coverImage));
      const docs = await tx.eventDocument.findMany({ where: { eventId: { in: eventIds } }, select: { url: true } });
      docs.forEach(d => push(d.url));
    }

    if (bookingIds.length) {
      const logistics = await tx.bookingLogistic.findMany({ where: { bookingRequestId: { in: bookingIds } }, select: { fileUrl: true } });
      logistics.forEach(l => push(l.fileUrl));
      const bookingMedia = await tx.bookingMedia.findMany({ where: { bookingRequestId: { in: bookingIds } }, select: { url: true } });
      bookingMedia.forEach(m => push(m.url));
    }
  }

  const attachments = await tx.message.findMany({
    where: { senderId: userId, attachmentUrl: { not: null } },
    select: { attachmentUrl: true },
  });
  attachments.forEach(m => push(m.attachmentUrl));

  return [...new Set(urls)];
}

/**
 * Supprime un compte et tout ce qui lui est rattaché.
 * Renvoie le nombre de fichiers effacés du stockage.
 */
async function deleteUserAccount(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { profile: { select: { id: true } } },
  });
  if (!user) return null;

  const profileId = user.profile?.id ?? null;
  let fileUrls = [];

  await prisma.$transaction(async (tx) => {

    // IDs des offres, événements, contrats et bookings de ce profil
    const offerIds = profileId
      ? (await tx.offer.findMany({ where: { organizerId: profileId }, select: { id: true } })).map(o => o.id)
      : [];
    const eventIds = profileId
      ? (await tx.event.findMany({ where: { profileId }, select: { id: true } })).map(e => e.id)
      : [];
    const bookingWhere = { OR: [{ requesterId: profileId ?? -1 }, { targetId: profileId ?? -1 }] };
    if (eventIds.length) bookingWhere.OR.push({ eventId: { in: eventIds } });
    const bookingIds = profileId
      ? (await tx.bookingRequest.findMany({ where: bookingWhere, select: { id: true } })).map(b => b.id)
      : [];

    fileUrls = await collectFileUrls(tx, id, profileId, eventIds, bookingIds);

    if (profileId) {
      const contractWhere = { OR: [{ senderId: profileId }, { recipientId: profileId }] };
      if (eventIds.length) contractWhere.OR.push({ eventId: { in: eventIds } });
      const contractIds = (await tx.contract.findMany({ where: contractWhere, select: { id: true } })).map(c => c.id);

      // 1. Paiements
      await tx.payment.deleteMany({ where: { OR: [{ payerId: profileId }, { recipientId: profileId }] } });
      if (contractIds.length) await tx.payment.deleteMany({ where: { contractId: { in: contractIds } } });

      // 2. Notifications liées aux offres de ce profil
      if (offerIds.length) await tx.notification.deleteMany({ where: { offerId: { in: offerIds } } });

      // 3. Candidatures (envoyées par ce profil + reçues sur ses offres)
      await tx.application.deleteMany({ where: { applicantId: profileId } });
      if (offerIds.length) await tx.application.deleteMany({ where: { offerId: { in: offerIds } } });

      // 4. Offres
      if (offerIds.length) await tx.offer.deleteMany({ where: { id: { in: offerIds } } });

      // 5. Avis (donnés/reçus + liés aux événements)
      await tx.review.deleteMany({ where: { OR: [{ authorId: profileId }, { targetId: profileId }] } });
      if (eventIds.length) await tx.review.deleteMany({ where: { eventId: { in: eventIds } } });

      // 6. Contrats (staffId mis à null d'abord pour lever le lien avec EventStaff)
      if (contractIds.length) {
        await tx.contract.updateMany({ where: { id: { in: contractIds } }, data: { staffId: null } });
        await tx.contract.deleteMany({ where: { id: { in: contractIds } } });
      }

      // 7. Bookings (avant les événements : un booking peut pointer vers un événement du profil)
      if (bookingIds.length) await tx.bookingRequest.deleteMany({ where: { id: { in: bookingIds } } });

      // 8. EventStaff
      if (eventIds.length) await tx.eventStaff.deleteMany({ where: { eventId: { in: eventIds } } });
      await tx.eventStaff.deleteMany({ where: { profileId } });

      // 9. Événements
      if (eventIds.length) await tx.event.deleteMany({ where: { id: { in: eventIds } } });

      // 10. Likes + Publications
      const pubIds = (await tx.publication.findMany({ where: { profileId }, select: { id: true } })).map(p => p.id);
      if (pubIds.length) await tx.publicationLike.deleteMany({ where: { publicationId: { in: pubIds } } });
      await tx.publicationLike.deleteMany({ where: { profileId } });
      await tx.publication.deleteMany({ where: { profileId } });

      // 11. Préférences de notification
      await tx.notificationPreferences.deleteMany({ where: { profileId } });

      // 12. Media liés au profil
      await tx.media.deleteMany({ where: { profileId } });
    }

    // 13. Notifications liées à cet utilisateur (userId ou actorId)
    await tx.notification.deleteMany({ where: { OR: [{ userId: id }, { actorId: id }] } });

    // 14. Messages envoyés — mettre messageId à null dans les notifications d'autres users
    const msgIds = (await tx.message.findMany({ where: { senderId: id }, select: { id: true } })).map(m => m.id);
    if (msgIds.length) {
      await tx.notification.updateMany({ where: { messageId: { in: msgIds } }, data: { messageId: null } });
      await tx.message.deleteMany({ where: { senderId: id } });
    }

    // 15. Participations aux conversations
    await tx.conversationParticipant.deleteMany({ where: { userId: id } });

    // 16. Follows + Blocks
    await tx.follow.deleteMany({ where: { OR: [{ followerId: id }, { followingId: id }] } });
    await tx.block.deleteMany({ where: { OR: [{ blockerId: id }, { blockedId: id }] } });

    // 17. Media liés à l'utilisateur
    await tx.media.deleteMany({ where: { userId: id } });

    // 18. Abonnement
    await tx.subscription.deleteMany({ where: { userId: id } });

    // 19. Profil (albums, commentaires, disponibilités supprimés en cascade)
    if (profileId) await tx.profile.delete({ where: { id: profileId } });

    // 20. Réinitialisations de mot de passe
    await tx.passwordReset.deleteMany({ where: { userId: id } });

    // 21. Utilisateur
    await tx.user.delete({ where: { id } });

  }, { timeout: 30000 });

  // Fichiers : après la transaction (une erreur de stockage ne doit pas bloquer la suppression)
  await Promise.all(fileUrls.map(deleteR2Object));
  return { deletedFiles: fileUrls.length };
}

module.exports = { deleteUserAccount };
